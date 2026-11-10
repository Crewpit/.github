#!/usr/bin/env node
// Rebuilds registry.json from the Crewpit repos.
// Picks public cockpit-* repos (plus whatever is in config.include) that have a
// preflight.json with a version and more than minFiles files. Anything smaller
// is probably still WIP, so we skip it.
// order: config.pinned first, then the rest A-Z
// name <- override, else manifest label, else repo name
// version <- preflight.json
// description <- override, else the GitHub repo description, else what we had
import { readFile, writeFile } from "node:fs/promises";

const config = JSON.parse(await readFile(new URL("../registry-sync.config.json", import.meta.url), "utf8"));
const registryPath = new URL("../registry.json", import.meta.url);
const token = process.env.GITHUB_TOKEN;
const headers = { Accept: "application/vnd.github+json", "User-Agent": "crewpit-registry-sync", ...(token && { Authorization: `Bearer ${token}` }) };

async function getJson(url, { optional = false } = {}) {
  const res = await fetch(url, { headers });
  if (res.status === 404 && optional) return null;
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

async function listRepos() {
  const all = [];
  for (let page = 1; ; page++) {
    const batch = await getJson(`https://api.github.com/orgs/${config.org}/repos?type=public&per_page=100&page=${page}`);
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}

const existing = JSON.parse(await readFile(registryPath, "utf8"));
const prev = new Map(existing.apps.map((a) => [a.href, a]));

const repos = (await listRepos()).filter(
  (r) => !r.private && !r.archived && !r.fork && !config.exclude.includes(r.name) &&
    (r.name.startsWith(config.prefix) || config.include.includes(r.name)),
);

const found = [];
for (const r of repos) {
  const raw = (f) => `https://raw.githubusercontent.com/${config.org}/${r.name}/${r.default_branch}/${f}`;
  const get = async (f) => { const res = await fetch(raw(f)); return res.ok ? res.json() : null; };
  const preflight = await get("preflight.json");
  if (!preflight?.version) { console.log(`skip ${r.name}: no preflight.json version (WIP)`); continue; }
  const tree = await getJson(`https://api.github.com/repos/${config.org}/${r.name}/git/trees/${r.default_branch}?recursive=1`, { optional: true });
  const files = tree?.tree?.filter((t) => t.type === "blob").length ?? 0;
  if (files <= config.minFiles) { console.log(`skip ${r.name}: only ${files} files (WIP)`); continue; }
  const manifest = await get("manifest.json");
  const o = config.overrides[r.name] ?? {};
  const old = prev.get(r.html_url);
  found.push({
    repo: r.name,
    name: o.name ?? manifest?.tools?.index?.label ?? r.name,
    description: o.description ?? r.description ?? old?.description ?? "",
    version: preflight.version,
    href: r.html_url,
  });
}

// order: config.pinned first (in that order), then everything else A-Z by name
const rank = (repo) => { const i = config.pinned.indexOf(repo); return i === -1 ? config.pinned.length : i; };
found.sort((a, b) => rank(a.repo) - rank(b.repo) || a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
const apps = found.map(({ repo, ...app }) => app);

// a missing updatedAt counts as a change so the first run adds the field
const same = JSON.stringify(apps) === JSON.stringify(existing.apps) && existing.updatedAt;
if (same) { console.log("registry unchanged"); process.exit(0); }

// updatedAt = unix seconds of the run that last changed the list (handy for Crewmate and for debugging)
const out = { ...existing, updated: new Date().toISOString().slice(0, 10), updatedAt: Math.floor(Date.now() / 1000), apps };
const line = (a) => "    " + JSON.stringify(a).replace(/^\{/, "{ ").replace(/\}$/, " }").replace(/":/g, '": ').replace(/,"/g, ', "');
const text = `{\n  "cmSchema": ${out.cmSchema},\n  "updated": "${out.updated}",\n  "updatedAt": ${out.updatedAt},\n  "apps": [\n${apps.map(line).join(",\n")}\n  ]\n}\n`;
await writeFile(registryPath, text);
console.log(`registry updated: ${apps.length} apps`);
