function timestamp() {
  return new Date().toISOString();
}

export function log(message, ...details) {
  console.log(`[${timestamp()}] ${message}`, ...details);
}

export function warn(message, ...details) {
  console.warn(`[${timestamp()}] WARN: ${message}`, ...details);
}

export function error(message, ...details) {
  console.error(`[${timestamp()}] ERROR: ${message}`, ...details);
}
