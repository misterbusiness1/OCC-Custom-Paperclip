import net from "node:net";

import { readLocalServicePortOwner } from "../server/dist/services/local-service-supervisor.js";

if (process.platform !== "linux") {
  throw new Error(`Container port-owner smoke requires Linux, received ${process.platform}`);
}

const listener = net.createServer();

try {
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });

  const address = listener.address();
  if (!address || typeof address === "string") {
    throw new Error("Disposable listener did not expose a TCP port");
  }

  const ownerPid = await readLocalServicePortOwner(address.port);
  if (ownerPid !== process.pid) {
    throw new Error(`Expected listener owner PID ${process.pid}, received ${ownerPid ?? "null"}`);
  }

  console.log(`PASS: detected disposable listener owner PID ${ownerPid}`);
} finally {
  await new Promise((resolve, reject) => {
    listener.close((error) => error ? reject(error) : resolve());
  });
}
