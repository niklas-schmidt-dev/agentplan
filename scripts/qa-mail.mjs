import http from "node:http";
import { timingSafeEqual } from "node:crypto";

export function startInbox(port, secret) {
  const messages = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/healthz") {
      res.end('{"status":"ok"}');
      return;
    }
    if (req.method === "GET" && url.pathname === "/messages") {
      res.end(
        JSON.stringify(messages.filter((message) => message.to === url.searchParams.get("to"))),
      );
      return;
    }
    const actual = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${secret}`);
    if (
      req.method !== "POST" ||
      url.pathname !== "/" ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      res.writeHead(403).end("{}");
      return;
    }
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 16_384) throw new Error("message too large");
      }
      const message = JSON.parse(body);
      if (
        !["verify_email", "reset_password"].includes(message.kind) ||
        typeof message.to !== "string" ||
        typeof message.url !== "string"
      )
        throw new Error("invalid message");
      messages.push(message);
      if (messages.length > 500) messages.shift();
      res.end('{"ok":true}');
    } catch {
      res.writeHead(400).end("{}");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
