export const isLoopback = address => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address);

export function clientIp(req) {
  const socket = req.socket.remoteAddress || "";
  if (!isLoopback(socket)) return socket;
  return String(req.headers["cf-connecting-ip"] || "").trim()
    || socket;
}
