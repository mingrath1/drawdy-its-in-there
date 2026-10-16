import { describe, expect, it } from "vitest";
import { KeyedSerialQueue } from "../src/serial.ts";

describe("connection operation serialization", () => {
  it("runs operations for one connection in order without blocking another", async () => {
    const queue = new KeyedSerialQueue<object>();
    const firstConnection = {};
    const secondConnection = {};
    const release = Promise.withResolvers<void>();
    const order: string[] = [];

    const first = queue.run(firstConnection, async () => {
      order.push("first:start");
      await release.promise;
      order.push("first:end");
    });
    const second = queue.run(firstConnection, () => {
      order.push("second");
    });
    const independent = queue.run(secondConnection, () => {
      order.push("independent");
    });

    await independent;
    expect(order).toEqual(["first:start", "independent"]);

    release.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "independent", "first:end", "second"]);
  });

  it("continues a connection queue after an operation fails", async () => {
    const queue = new KeyedSerialQueue<object>();
    const connection = {};
    const failed = queue.run(connection, () => {
      throw new Error("failed");
    });
    const recovered = queue.run(connection, () => "recovered");

    await expect(failed).rejects.toThrow("failed");
    await expect(recovered).resolves.toBe("recovered");
  });
});
