import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const errors = [];

function fail(message) {
  errors.push(message);
}

function exists(relativePath) {
  return fs.existsSync(path.join(root, relativePath));
}

const requiredFiles = [
  "index.html",
  "css/styles.css",
  "js/app.js",
  "js/config.js",
  "js/config.example.js",
  "assets/patient-desk-logo.jpg",
  "SECURITY.md",
  "docs/SUPABASE_RECOVERY.md",
  "sql/00_full_recovery.sql",
  "sql/01_base_schema.sql",
  "sql/02_e2ee_migration.sql",
  "sql/03_restore_encrypted_backup.sql",
  "sql/04_bootstrap_new_practice.sql",
  "sql/05_verify_installation.sql"
];

for (const file of requiredFiles) {
  if (!exists(file)) {
    fail(`Required file is missing: ${file}`);
  }
}

const forbiddenPlaceholderFiles = [
  "docs/f",
  "js/f",
  "sql/supabase"
];

for (const file of forbiddenPlaceholderFiles) {
  if (exists(file)) {
    fail(`Remove stray placeholder file: ${file}`);
  }
}

const htmlPath = path.join(root, "index.html");
if (fs.existsSync(htmlPath)) {
  const html = fs.readFileSync(htmlPath, "utf8");

  if (!/<!doctype html/i.test(html)) {
    fail("index.html is missing an HTML5 doctype.");
  }

  for (const expected of ["css/styles.css", "js/config.js", "js/app.js"]) {
    if (!html.includes(expected)) {
      fail(`index.html does not reference ${expected}.`);
    }
  }

  const refs = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean);

  for (const ref of refs) {
    if (
      ref.startsWith("#") ||
      ref.startsWith("data:") ||
      ref.startsWith("mailto:") ||
      ref.startsWith("tel:") ||
      ref.startsWith("javascript:") ||
      ref.startsWith("//") ||
      /^[a-z][a-z0-9+.-]*:/i.test(ref)
    ) {
      continue;
    }

    const clean = ref.split("#")[0].split("?")[0].replace(/^\/+/, "");
    if (!clean) continue;

    if (!exists(clean)) {
      fail(`index.html references a missing local file: ${ref}`);
    }
  }
}

const exampleConfigPath = path.join(root, "js/config.example.js");
if (fs.existsSync(exampleConfigPath)) {
  const example = fs.readFileSync(exampleConfigPath, "utf8");

  if (!example.includes("YOUR_PROJECT_REF")) {
    fail("js/config.example.js should keep a placeholder project reference.");
  }

  if (!example.includes("YOUR_PUBLISHABLE_KEY")) {
    fail("js/config.example.js should keep a placeholder publishable key.");
  }
}

const liveConfigPath = path.join(root, "js/config.js");
if (fs.existsSync(liveConfigPath)) {
  const config = fs.readFileSync(liveConfigPath, "utf8");

  if (/sb_secret_/i.test(config)) {
    fail("js/config.js appears to contain a Supabase secret key. Browser code must use only a publishable/anon key.");
  }

  const jwtMatches = config.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) || [];
  for (const token of jwtMatches) {
    try {
      const payload = token.split(".")[1]
        .replace(/-/g, "+")
        .replace(/_/g, "/");
      const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
      const decoded = JSON.parse(Buffer.from(padded, "base64").toString("utf8"));

      if (decoded.role === "service_role") {
        fail("js/config.js contains a Supabase service_role JWT. Never expose this key in browser code.");
      }
    } catch {
      // Ignore tokens that are not decodable JWT payloads.
    }
  }
}

const readmePath = path.join(root, "README.md");
if (fs.existsSync(readmePath)) {
  const readme = fs.readFileSync(readmePath, "utf8");

  if (readme.includes("docs/screenshot.png") && !exists("docs/screenshot.png")) {
    fail("README.md references docs/screenshot.png, but that file does not exist.");
  }
}

if (errors.length > 0) {
  console.error("\nPatient Desk repository checks failed:\n");
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log("Patient Desk repository smoke checks passed.");
