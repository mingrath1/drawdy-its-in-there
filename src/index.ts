import type { DriverModule } from "@drawdy/driver-protocol";
import { createSend } from "./driver/command.ts";
import { createHuntDriver } from "./driver/hunt.ts";
import type { HuntDriver } from "./driver/hunt.ts";

let driver: HuntDriver | null = null;

export const activate: DriverModule["activate"] = async (ctx) => {
    driver = createHuntDriver({
        send: createSend(ctx.issueCommand, ctx.manifest.driverId),
        generateId: ctx.generateId,
        styling: ctx.styling,
    });
    await driver.activate();
};

export const onEvent: DriverModule["onEvent"] = async (event) => {
    driver?.handleEvent(event);
};
