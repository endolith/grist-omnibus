#!/usr/bin/env node

const fs = require('fs');
const child_process = require('child_process');
const commander = require('commander');
const fetch = require('node-fetch');
const https = require('https');
const path = require('path');

async function main() {
  const {program} = commander;
  program.option('-p, --part <part>');
  program.parse();
  const options = program.opts();
  const part = options.part || 'all';

  prepareDirectories();
  prepareMainSettings();
  prepareNetworkSettings();
  prepareCertificateSettings();
  if (part === 'grist' || part === 'all') {
    startGrist();
  }
  if (part === 'traefik' || part === 'all') {
    startTraefik();
  }
  if (part === 'who' || part === 'all') {
    startWho();
  }
  if (part === 'dex' || part === 'all') {
    startDex();
  }
  if (part === 'tfa' || part === 'all') {
    await waitForDex();
    startTfa();
  }
  await sleep(1000);
  console.log('I think everything has started up now');
  if (part === 'all') {
    const ports = process.env.HTTPS ? '80/443' : '80';
    console.log(`Listening internally on ${ports}, externally at ${process.env.URL}`);
  }
}

main().catch(e => console.error(e));

function prepareDirectories() {
  fs.mkdirSync('/persist/auth', { recursive: true });
}

function startGrist() {
  child_process.spawn('/grist/sandbox/run.sh', {
    env: {
      ...process.env,
      PORT: process.env.GRIST_PORT,
    },
    stdio: 'inherit',
    detached: true,
  });
}

function startTraefik() {
  const flags = [];
  flags.push("--providers.file.filename=/settings/traefik.yaml");
  // flags.push("--api.dashboard=true --api.insecure=true");
  flags.push("--entryPoints.web.address=:80")

  if (process.env.HTTPS === 'auto') {
    flags.push(`--certificatesResolvers.letsencrypt.acme.email=${process.env.EMAIL}`)
    flags.push("--certificatesResolvers.letsencrypt.acme.storage=/persist/acme.json")
    flags.push("--certificatesResolvers.letsencrypt.acme.tlschallenge=true")
  }
  if (process.env.HTTPS) {
    flags.push("--entrypoints.websecure.address=:443")
  }

  console.log("Calling traefik", flags);
  console.log(child_process.execSync('env', { encoding: 'utf-8' }));
  child_process.spawn('traefik', flags, {
    env: process.env,
    stdio: 'inherit',
    detached: true,
  });
}

function startDex() {
  let txt = fs.readFileSync('/settings/dex.yaml', { encoding: 'utf-8' });
  txt += addDexUsers();
  const customFile = '/custom/dex.yaml';
  if (fs.existsSync(customFile)) {
    console.log(`Using ${customFile}`)
    txt = fs.readFileSync(customFile, { encoding: 'utf-8' });
  } else {
    console.log(`No ${customFile}`)
  }
  fs.writeFileSync('/persist/dex-full.yaml', txt, { encoding: 'utf-8' });
  child_process.spawn('dex-entrypoint', [
    'dex', 'serve', '/persist/dex-full.yaml'
  ], {
    env: process.env,
    stdio: 'inherit',
    detached: true,
  });  
}

function startTfa() {
  console.log('Starting traefik-forward-auth');
  child_process.spawn('traefik-forward-auth', [
    `--port=${process.env.TFA_PORT}`
  ], {
    env: process.env,
    stdio: 'inherit',
    detached: true,
  });
}

function startWho() {
  child_process.spawn('whoami', {
    env: {
      ...process.env,
      WHOAMI_PORT_NUMBER: process.env.WHOAMI_PORT,
    },
    stdio: 'inherit',
    detached: true,
  });
}

function prepareMainSettings() {

  // Enable sandboxing by default.
  setDefaultEnv('GRIST_SANDBOX_FLAVOR', 'gvisor');
  // TODO: gvisor may fail on some old hardware, or in environments with
  // particular limits. It would be kind to catch that and give clear
  // feedback to installer.

  // By default, hide UI elements that require a lot of setup.
  setDefaultEnv('GRIST_HIDE_UI_ELEMENTS', 'helpCenter,billing,templates,multiSite,multiAccounts');

  // Support URL as a synonym of APP_HOME_URL, and make it mandatory.
  setSynonym('URL', 'APP_HOME_URL');
  if (!process.env.URL) {
    throw new Error('Please define URL so Grist knows how users will access it.');
  }

  // Support EMAIL as a synonym of GRIST_DEFAULT_EMAIL, and make it mandatory.
  setSynonym('EMAIL', 'GRIST_DEFAULT_EMAIL');
  if (!process.env.EMAIL) {
    throw new Error('Please provide an EMAIL, needed for certificates and initial login.');
  }

  // Support TEAM as a synonym of GRIST_SINGLE_ORG, and make it mandatory for now.
  // Working with multiple teams is possible but a little harder to explain
  // and understand, and the UI has rough edges.
  setSynonym('TEAM', 'GRIST_SINGLE_ORG');
  if (!process.env.TEAM) {
    throw new Error('Please set TEAM, omnibus version of Grist expects it.');
  }
  setDefaultEnv('GRIST_ORG_IN_PATH', 'false');

  setDefaultEnv('GRIST_FORWARD_AUTH_HEADER', 'X-Forwarded-User');
  setBrittleEnv('GRIST_FORWARD_AUTH_LOGOUT_PATH', '_oauth/logout');
  setDefaultEnv('GRIST_FORCE_LOGIN', 'true');

  if (!process.env.GRIST_SESSION_SECRET) {
    process.env.GRIST_SESSION_SECRET = invent('GRIST_SESSION_SECRET');
  }
}

function prepareNetworkSettings() {
  const url = new URL(process.env.URL);
  process.env.APP_HOST = url.hostname || 'localhost';
  // const extPort = parseInt(url.port || '9999', 10);
  const extPort = url.port || '9999';
  process.env.EXT_PORT = extPort;

  // traefik-forward-auth will try to talk directly to dex, so it is
  // important that URL works internally, withing the container. But
  // if URL contains localhost, it really won't.  We can finess that
  // by tying DEX_PORT to EXT_PORT in that case. As long as it isn't
  // 80 or 443, since traefik is listening there...

  process.env.DEX_PORT = '9999';
  if (process.env.APP_HOST === 'localhost' && extPort !== '80' && extPort !== '443') {
    process.env.DEX_PORT = process.env.EXT_PORT;
  }

  // Keep other ports out of the way of Dex port.
  const alt = String(process.env.DEX_PORT).charAt(0) === '1' ? '2' : '1';
  process.env.GRIST_PORT = `${alt}7100`;
  process.env.TFA_PORT = `${alt}7101`;
  process.env.WHOAMI_PORT = `${alt}7102`;

  setBrittleEnv('DEFAULT_PROVIDER', 'oidc');
  process.env.PROVIDERS_OIDC_CLIENT_ID = invent('PROVIDERS_OIDC_CLIENT_ID');
  process.env.PROVIDERS_OIDC_CLIENT_SECRET = invent('PROVIDERS_OIDC_CLIENT_SECRET');
  process.env.PROVIDERS_OIDC_ISSUER_URL = `${process.env.APP_HOME_URL}/dex`;
  process.env.SECRET = invent('TFA_SECRET');
  process.env.LOGOUT_REDIRECT = `${process.env.APP_HOME_URL}/signed-out`;
}

function setSynonym(name1, name2) {
  if (process.env[name1] && process.env[name2] && process.env[name1] !== process.env[name2]) {
    throw new Error(`${name1} and ${name2} are synonyms and should be the same`);
  }
  if (process.env[name1]) { setDefaultEnv(name2, process.env[name1]); }
  if (process.env[name2]) { setDefaultEnv(name1, process.env[name2]); }
}

// Set a default for an environment variable.
function setDefaultEnv(name, value) {
  if (process.env[name] === undefined) {
    process.env[name] = value;
  }
}

function setBrittleEnv(name, value) {
  if (process.env[name] !== undefined && process.env[name] !== value) {
    throw new Error(`Sorry, we need to set ${name} (we want to set it to ${value})`);
  }
  process.env[name] = value;
}

function invent(key) {
  const dir = '/persist/params';
  fs.mkdirSync(dir, { recursive: true });
  const fname = path.join(dir, key);
  if (!fs.existsSync(fname)) {
    const val = child_process.execSync('pwgen -s 20', { encoding: 'utf-8' });
    fs.writeFileSync(fname, val.trim(), { encoding: 'utf-8' });
  }
  return fs.readFileSync(fname, { encoding: 'utf-8' }).trim();
}

function addDexUsers() {

  let hasEmail = false;
  const txt = [];

  function activate() {
    if (hasEmail) { return; }
    hasEmail = true;
    txt.push("enablePasswordDB: true");
    txt.push("staticPasswords:");
  }

  function deactivate() {
    if (!hasEmail) { return; }
    txt.push("");
  }

  function emit(user) {
    activate();
    txt.push(`- email: "${user.email}"`);
    txt.push(`  hash: "${user.hash}"`);
  }

  function go(suffix) {
    var emailKey = 'EMAIL' + suffix;
    var passwordKey = 'PASSWORD' + suffix;
    const email = process.env[emailKey];
    if (!email) { return false; }
    const passwd = process.env[passwordKey];
    if (!passwd) {
      console.error(`Found ${emailKey} without a matching ${passwordKey}, skipping`);
      return true;
    }
    const hash = child_process.execSync('htpasswd -BinC 10 no_username', { input: passwd, encoding: 'utf-8' }).split(':')[1].trim();
    emit({ email, hash });
    return true;
  }

  go('');
  go('0');
  go('1');
  let i = 2;
  while (go(String(i))) {
    i++;
  }
  deactivate();
  return txt.join('\n') + '\n';
}

async function waitForDex() {
  const fetchOptions = process.env.HTTPS ? {
    agent: new https.Agent({
      // Allow self-signed certs for this wait loop. We only care if dex
      // is up and running, not whether it has valid certs.
      rejectUnauthorized: false,
    })
  } : {};
  let delay = 0.1;
  while (true) {
    const url = process.env.PROVIDERS_OIDC_ISSUER_URL + '/.well-known/openid-configuration';
    console.log(`Checking dex... at ${url}`);
    try {
      const result = await fetch(url, fetchOptions);
      console.log(`  got: ${result.status}`);
      if (result.status === 200) { break; }
    } catch (e) {
      console.log(`  not ready: ${e}`);
    }
    await sleep(1000 * delay);
    delay = Math.min(5.0, delay * 1.2);
  }
  console.log("Happy with dex");
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function prepareCertificateSettings() {
  const url = new URL(process.env.URL);
  if (url.protocol === 'https:') {
    const https = String(process.env.HTTPS);
    if (!['auto', 'external', 'manual'].includes(https)) {
      throw new Error(`HTTPS environment variable must be set to: auto, external, or manual.`);
    }
    const tls = (https === 'auto') ? '{ certResolver: letsencrypt }' :
          (https === 'manual') ? 'true' : 'false';
    process.env.TLS = tls;
    process.env.USE_HTTPS = 'true';
  }
}
