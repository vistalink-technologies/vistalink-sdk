import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Where `vistalink login` keeps keys. No native modules (no keytar):
 *  - macOS: the login keychain through `security`, fed on stdin (`security -i`)
 *    so the key never appears in a process listing;
 *  - Linux: the Secret Service through `secret-tool` (key on stdin);
 *  - otherwise, or with VISTALINK_CREDENTIAL_STORE=file:
 *    ~/.config/vistalink/credentials (dir 0700, file 0600).
 * Non-secret profile metadata (store used, base URL, masked key) lives in
 * ~/.config/vistalink/config.json.
 */
export const SERVICE = "vistalink-cli";

export interface SecretBackend {
  readonly name: "keychain" | "secret-service" | "file";
  get(profile: string): string | null;
  set(profile: string, key: string): void;
  delete(profile: string): void;
}

export interface ProfileMeta {
  store: SecretBackend["name"];
  base_url?: string;
  key_hint: string;
  saved_at: string;
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "vistalink");
}

/** `vl_live_abcdefgh…wxyz` → `vl_live_abcd…wxyz`. */
export function maskKey(key: string): string {
  const m = /^(vl_(?:live|test)_)(.*)$/.exec(key);
  const prefix = m ? m[1] : "";
  const rest = m ? m[2] : key;
  if (rest.length <= 8) return `${prefix}${"*".repeat(rest.length)}`;
  return `${prefix}${rest.slice(0, 4)}…${rest.slice(-4)}`;
}

function ensureDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writePrivate(path: string, content: string) {
  ensureDir(dirname(path));
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600); // also tightens a pre-existing file
}

export class FileBackend implements SecretBackend {
  readonly name = "file" as const;
  constructor(private readonly dir: string) {}
  get path() {
    return join(this.dir, "credentials");
  }
  private load(): Record<string, { api_key: string }> {
    return readJson(this.path, {});
  }
  get(profile: string) {
    return this.load()[profile]?.api_key ?? null;
  }
  set(profile: string, key: string) {
    const all = this.load();
    all[profile] = { api_key: key };
    writePrivate(this.path, JSON.stringify(all, null, 2) + "\n");
  }
  delete(profile: string) {
    const all = this.load();
    if (!(profile in all)) return;
    delete all[profile];
    writePrivate(this.path, JSON.stringify(all, null, 2) + "\n");
  }
}

type Run = (cmd: string, args: string[], input?: string) => { status: number | null; stdout: string };
const run: Run = (cmd, args, input) => {
  const r = spawnSync(cmd, args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? "" };
};

export class MacKeychainBackend implements SecretBackend {
  readonly name = "keychain" as const;
  constructor(private readonly exec: Run = run) {}
  static available(exec: Run = run): boolean {
    return process.platform === "darwin" && exec("/usr/bin/security", ["help"]).status !== null;
  }
  get(profile: string) {
    const r = this.exec("/usr/bin/security", ["find-generic-password", "-s", SERVICE, "-a", profile, "-w"]);
    return r.status === 0 ? r.stdout.replace(/\n$/, "") : null;
  }
  set(profile: string, key: string) {
    if (!/^[A-Za-z0-9_.-]+$/.test(key) || !/^[A-Za-z0-9_.-]+$/.test(profile)) {
      throw new Error("Key and profile may only contain letters, digits, '_', '.', '-'");
    }
    // Interactive mode reads the command from stdin: the key is not in argv.
    const r = this.exec("/usr/bin/security", ["-i"], `add-generic-password -U -s ${SERVICE} -a ${profile} -l "VistaLink CLI (${profile})" -w ${key}\n`);
    if (r.status !== 0) throw new Error("Could not write to the macOS keychain");
  }
  delete(profile: string) {
    this.exec("/usr/bin/security", ["delete-generic-password", "-s", SERVICE, "-a", profile]);
  }
}

export class SecretServiceBackend implements SecretBackend {
  readonly name = "secret-service" as const;
  constructor(private readonly exec: Run = run) {}
  static available(env: NodeJS.ProcessEnv = process.env, exec: Run = run): boolean {
    return process.platform === "linux" && !!env.DBUS_SESSION_BUS_ADDRESS && exec("secret-tool", ["--version"]).status === 0;
  }
  get(profile: string) {
    const r = this.exec("secret-tool", ["lookup", "service", SERVICE, "account", profile]);
    return r.status === 0 && r.stdout ? r.stdout.replace(/\n$/, "") : null;
  }
  set(profile: string, key: string) {
    const r = this.exec("secret-tool", ["store", `--label=VistaLink CLI (${profile})`, "service", SERVICE, "account", profile], key);
    if (r.status !== 0) throw new Error("Could not write to the Secret Service");
  }
  delete(profile: string) {
    this.exec("secret-tool", ["clear", "service", SERVICE, "account", profile]);
  }
}

export function pickBackend(env: NodeJS.ProcessEnv = process.env, dir = configDir(env)): SecretBackend {
  const forced = env.VISTALINK_CREDENTIAL_STORE;
  if (forced === "file") return new FileBackend(dir);
  if ((!forced || forced === "keychain") && MacKeychainBackend.available()) return new MacKeychainBackend();
  if ((!forced || forced === "secret-service") && SecretServiceBackend.available(env)) return new SecretServiceBackend();
  return new FileBackend(dir);
}

export class CredentialStore {
  constructor(
    readonly dir: string,
    private readonly backends: { preferred: SecretBackend; byName: (n: ProfileMeta["store"]) => SecretBackend },
  ) {}

  static default(env: NodeJS.ProcessEnv = process.env): CredentialStore {
    const dir = configDir(env);
    const preferred = pickBackend(env, dir);
    return new CredentialStore(dir, {
      preferred,
      byName: (n) =>
        n === preferred.name ? preferred : n === "keychain" ? new MacKeychainBackend() : n === "secret-service" ? new SecretServiceBackend() : new FileBackend(dir),
    });
  }

  get configPath() {
    return join(this.dir, "config.json");
  }

  profiles(): Record<string, ProfileMeta> {
    return readJson<{ profiles?: Record<string, ProfileMeta> }>(this.configPath, {}).profiles ?? {};
  }

  private saveProfiles(profiles: Record<string, ProfileMeta>) {
    writePrivate(this.configPath, JSON.stringify({ profiles }, null, 2) + "\n");
  }

  save(profile: string, key: string, baseUrl?: string): ProfileMeta {
    let backend = this.backends.preferred;
    try {
      backend.set(profile, key);
    } catch {
      backend = this.backends.byName("file");
      backend.set(profile, key);
    }
    const meta: ProfileMeta = { store: backend.name, key_hint: maskKey(key), saved_at: new Date().toISOString() };
    if (baseUrl) meta.base_url = baseUrl;
    this.saveProfiles({ ...this.profiles(), [profile]: meta });
    return meta;
  }

  load(profile: string): { key: string; meta: ProfileMeta } | null {
    const meta = this.profiles()[profile];
    if (!meta) return null;
    const key = this.backends.byName(meta.store).get(profile);
    return key ? { key, meta } : null;
  }

  remove(profile: string): boolean {
    const all = this.profiles();
    const meta = all[profile];
    if (!meta) return false;
    this.backends.byName(meta.store).delete(profile);
    delete all[profile];
    this.saveProfiles(all);
    return true;
  }
}
