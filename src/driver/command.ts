// The one door to Drawdy: request ids, a timeout on every command, and errors as exceptions.

import type {
    DistributiveOmit,
    DriverCommand,
    DriverCommandIssuer,
    DriverCommandRequest,
    DriverCommandResponse,
    ProtocolCommandError,
    ProtocolPermissionMap,
} from "@drawdy/driver-protocol";

export const log = (...args: unknown[]): void => console.log("[iit]", ...args);
export const warn = (...args: unknown[]): void => console.warn("[iit]", ...args);

/** Every command this driver issues, with the permission Drawdy's own map gives it. */
const PERMISSIONS = {
    "command:dom:create-action-button": "dom",
    "subscription:dom:element-clicked": "dom",
    "subscription:dom:theme-changed": "dom",
    "command:dom:window-size": "dom",
    "command:dom:upsert-floating-element": "dom",
    "command:dom:remove-floating-element": "dom",
    "command:camera:get-viewport-rect": "none",
    "command:scene:get-current-selected-drawdy-elements": "scene",
    "command:scene:get-drawdy-elements": "scene",
    "command:scene:query-combined-rect": "scene",
    "command:scene:query-rect": "scene",
    "command:scene:element-rects": "scene",
    "command:scene:add-drawdy-elements": "scene",
    "command:scene:remove-drawdy-elements": "scene",
    "command:scene:update-drawdy-elements": "scene",
    "command:scene:create-drawdy-preview-elements": "scene",
    "command:scene:update-drawdy-preview-elements": "scene",
    "command:scene:delete-drawdy-preview-elements": "scene",
    "command:tools:get-active": "scene",
    "command:tools:set-active": "scene",
    "subscription:tool:laser": "scene",
    "command:collaboration:get-all-users-in-board": "collaboration",
    "subscription:collaboration:presence-changed": "collaboration",
    "command:subscription:remove": "none",
} as const satisfies Partial<ProtocolPermissionMap>;

/** Probed on a live board (docs/FACTS.md): these never prompt, so they say nothing about a permission. */
const NEVER_PROMPTS: ReadonlySet<string> = new Set(["command:dom:create-action-button", "subscription:dom:element-clicked"]);

const COMMAND_TIMEOUT_MS = 8_000;
/** The first command behind a permission waits while the user reads Drawdy's permission dialog. */
const PROMPT_TIMEOUT_MS = 120_000;

type CommandType = keyof typeof PERMISSIONS;
type CommandRequest = DistributiveOmit<
    Extract<DriverCommandRequest, { type: CommandType }>,
    "driverId" | "requestId"
>;
type ValueOf<T extends CommandType> = Extract<Extract<DriverCommand, { type: T }>["res"], { error?: never }>["value"];

export type Send = <R extends CommandRequest>(request: R) => Promise<ValueOf<R["type"]>>;

export class CommandError extends Error {
    readonly command: CommandType;
    readonly reason: ProtocolCommandError["type"] | "timeout";
    constructor(command: CommandType, reason: ProtocolCommandError["type"] | "timeout", detail?: string) {
        super(`${command} failed: ${reason}${detail ? ` (${detail})` : ""}`);
        this.command = command;
        this.reason = reason;
    }
}

export function createSend(
    issueCommand: DriverCommandIssuer,
    driverId: string,
    timeouts = { command: COMMAND_TIMEOUT_MS, prompt: PROMPT_TIMEOUT_MS }
): Send {
    let sequence = 0;
    const answered = new Set<string>();

    return async (request) => {
        const permission = NEVER_PROMPTS.has(request.type) ? "none" : PERMISSIONS[request.type];
        const ms = permission === "none" || answered.has(permission) ? timeouts.command : timeouts.prompt;
        const full = { ...request, driverId, requestId: `iit-${sequence++}` } as DriverCommandRequest;

        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new CommandError(request.type, "timeout")), ms);
        });
        try {
            const response = (await Promise.race([issueCommand(full), timeout])) as DriverCommandResponse;
            answered.add(permission);
            if (response.res.error) {
                throw new CommandError(request.type, response.res.error.type, response.res.error.message);
            }
            return response.res.value as ValueOf<typeof request.type>;
        } finally {
            clearTimeout(timer);
        }
    };
}
