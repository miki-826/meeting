import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const env = process.env;
const PI_HOST = env.PI_HOST || "miki1586.local";
const PI_USER = env.PI_USER || "pi";
const PI_PORT = env.PI_PORT || "22";
const PI_APP_DIR = env.PI_APP_DIR || "/opt/talk2main-pi";
const PI_SERVICE_NAME = env.PI_SERVICE_NAME || "talk2main";
const INITIALIZE_PI = env.INITIALIZE_PI === "true";
const target = `${PI_USER}@${PI_HOST}`;

function assertMatch(name, value, pattern, hint) {
  if (!pattern.test(value)) {
    throw new Error(`${name} is invalid: ${value}. ${hint}`);
  }
}

assertMatch("PI_HOST", PI_HOST, /^[A-Za-z0-9._-]+$/, "Use a hostname, IPv4 address, or mDNS name.");
assertMatch("PI_USER", PI_USER, /^[A-Za-z_][A-Za-z0-9_-]*$/, "Use a normal Linux user name.");
assertMatch("PI_PORT", PI_PORT, /^[0-9]{1,5}$/, "Use a numeric SSH port.");
assertMatch("PI_APP_DIR", PI_APP_DIR, /^\/opt\/[A-Za-z0-9._/-]+$/, "Use an absolute path under /opt.");
assertMatch("PI_SERVICE_NAME", PI_SERVICE_NAME, /^[A-Za-z0-9_-]+$/, "Use letters, numbers, hyphen, or underscore.");

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const qAppDir = shellQuote(PI_APP_DIR);
const qServicePath = shellQuote(`/etc/systemd/system/${PI_SERVICE_NAME}.service`);
const qUser = shellQuote(PI_USER);
const qServiceName = shellQuote(PI_SERVICE_NAME);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: process.platform === "win32", ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function ssh(command) {
  run("ssh", ["-p", PI_PORT, target, command]);
}

console.log("Checking Raspberry Pi connection...");
ssh("echo Connected to Raspberry Pi.; echo Hostname: $(hostname); echo IP Address: $(hostname -I)");

if (INITIALIZE_PI) {
  console.log("INITIALIZE_PI=true: resetting app environment only.");
  ssh(`sudo rm -rf ${qAppDir} ${qServicePath} && sudo mkdir -p ${qAppDir} && sudo chown -R ${qUser}:${qUser} ${qAppDir}`);
  ssh(`if [ "$(hostname)" != "miki1586" ]; then sudo hostnamectl set-hostname miki1586; echo Raspberry Pi hostname was changed to miki1586.; echo Please reboot the Raspberry Pi manually if miki1586.local is not resolved.; fi`);
} else {
  ssh(`sudo mkdir -p ${qAppDir} && sudo chown -R ${qUser}:${qUser} ${qAppDir}`);
}

const archive = path.resolve(".deploy-talk2main.tar.gz");
if (fs.existsSync(archive)) fs.unlinkSync(archive);
run("tar", [
  "--exclude=node_modules",
  "--exclude=dist",
  "--exclude=.env",
  "--exclude=data/app.db",
  "--exclude=data/sessions",
  "--exclude=data/exports",
  "-czf",
  archive,
  "."
]);
run("scp", ["-P", PI_PORT, archive, `${target}:${PI_APP_DIR}/app.tar.gz`]);
ssh(`cd ${qAppDir} && tar -xzf app.tar.gz && rm app.tar.gz && npm ci && npm run build`);
ssh(`sudo tee ${qServicePath} >/dev/null <<'SERVICE'
[Unit]
Description=MeetingBot Discord Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${PI_APP_DIR}
EnvironmentFile=-${PI_APP_DIR}/.env
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
User=${PI_USER}
Group=${PI_USER}

[Install]
WantedBy=multi-user.target
SERVICE
sudo systemctl daemon-reload
sudo systemctl enable ${qServiceName}
`);

console.log("Deploy complete. Start or restart with:");
console.log(`ssh -p ${PI_PORT} ${target} "sudo systemctl restart ${PI_SERVICE_NAME}"`);
