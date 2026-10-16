/**
 * @fileoverview Unit tests for the scripts/rcon.js client framing.
 * Spins up a fake TCP RCON server (auth + command echo) so no Minecraft
 * server is needed.
 */

import * as net from "node:net";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { rconCommands } = require("../../scripts/rcon") as {
  rconCommands: (
    host: string,
    port: number,
    pass: string,
    cmds: string[],
  ) => Promise<string[]>;
};

function readPacket(sock: net.Socket): Promise<{
  id: number;
  type: number;
  body: string;
}> {
  return new Promise((resolve) => {
    let recv = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      recv = Buffer.concat([recv, chunk]);
      if (recv.length >= 4) {
        const size = recv.readInt32LE(0);
        if (recv.length >= 4 + size) {
          sock.off("data", onData);
          resolve({
            id: recv.readInt32LE(4),
            type: recv.readInt32LE(8),
            body: recv.slice(12, 4 + size - 2).toString("utf8"),
          });
        }
      }
    };
    sock.on("data", onData);
  });
}

function sendPacket(
  sock: net.Socket,
  id: number,
  type: number,
  body: string,
): void {
  const b = Buffer.from(body, "utf8");
  const buf = Buffer.alloc(14 + b.length);
  buf.writeInt32LE(10 + b.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  b.copy(buf, 12);
  buf.writeInt16LE(0, 12 + b.length);
  sock.write(buf);
}

describe("scripts/rcon", () => {
  test("authenticates and runs commands in order", async () => {
    const seen: string[] = [];
    const server = net.createServer((sock) => {
      (async () => {
        const auth = await readPacket(sock);
        expect(auth.type).toBe(3);
        if (auth.body === "right-pass") {
          sendPacket(sock, auth.id, 2, "");
        } else {
          sendPacket(sock, -1, 2, "");
          sock.end();
          return;
        }
        for (;;) {
          const cmd = await readPacket(sock);
          seen.push(cmd.body);
          sendPacket(sock, cmd.id, 0, `ok:${cmd.body}`);
        }
      })().catch(() => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
      const out = await rconCommands("127.0.0.1", port, "right-pass", [
        "list",
        "op Bob",
      ]);
      expect(out).toEqual(["ok:list", "ok:op Bob"]);
      expect(seen).toEqual(["list", "op Bob"]);
    } finally {
      server.close();
    }
  });

  test("rejects a wrong password", async () => {
    const server = net.createServer((sock) => {
      (async () => {
        const auth = await readPacket(sock);
        expect(auth.type).toBe(3);
        sendPacket(sock, -1, 2, "");
        sock.end();
      })().catch(() => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    try {
      await expect(
        rconCommands("127.0.0.1", port, "wrong-pass", ["list"]),
      ).rejects.toThrow("auth failed");
    } finally {
      server.close();
    }
  });
});
