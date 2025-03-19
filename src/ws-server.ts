import WebSocket from "ws";

import { logger } from "./common/logger";
import { config } from "./config";

const COMPONENT = "ws-server";

const MAX_CONNECTIONS = 100;

const wsServer = new WebSocket.Server({ port: config.wsPort });

wsServer.on("listening", () => {
  logger.info(COMPONENT, JSON.stringify({ msg: "Ws server started" }));
});

wsServer.on("connection", (connection) => {
  if (wsServer.clients.size > MAX_CONNECTIONS) {
    connection.terminate();
  } else {
    (connection as any).isAlive = true;
    connection.on("pong", () => {
      (connection as any).isAlive = true;
    });
  }
});

export const send = (data: string) =>
  wsServer.clients.forEach((connection) =>
    connection.send(JSON.stringify(data))
  );

setInterval(() => {
  wsServer.clients.forEach((connection) => {
    if (!(connection as any).isAlive) {
      return connection.terminate();
    }

    (connection as any).isAlive = false;
    connection.ping();
  });
}, 30000);
