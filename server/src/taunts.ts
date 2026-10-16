import { bundledTaunts, type TauntHost } from "../../src/shared/taunts.ts";

export { bundledTaunts, momentOf, type TauntHost, type TauntMoment } from "../../src/shared/taunts.ts";

/**
 * Extension point for an LLM taunt host, chosen by the TAUNT_HOST Worker variable, which is unset by default.
 * A model call cannot run inside a commit, so an LLM host would run as a durable pi-durable task that writes its
 * line into the hunt document, and the next snapshot would carry it. It chooses words only. It never draws and
 * never places targets.
 */
export function selectTauntHost(env: { readonly TAUNT_HOST?: string }): TauntHost {
  if (env.TAUNT_HOST === undefined || env.TAUNT_HOST === "") return bundledTaunts;
  throw new Error(`TAUNT_HOST=${env.TAUNT_HOST} names an LLM taunt host, and none is implemented yet`);
}
