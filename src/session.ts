import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * ⚠️ Lecture PARESSEUSE (même piège que db.ts et admin.ts) : un
 * `const X = process.env.Y` s'évalue à l'IMPORT. Ici cela toucherait
 * un SECRET — un module chargé avant la configuration signerait avec
 * une clé éphémère sans que rien ne le signale.
 */
let _secret: string | null = null;
function secret(): string {
  if (_secret) return _secret;
  _secret = process.env.SESSION_SECRET ?? randomBytes(32).toString('hex');
  if (!process.env.SESSION_SECRET)
    console.warn('[session] SESSION_SECRET absent : les sessions ne survivront pas à un redémarrage.');
  return _secret;
}

const sign = (v: string) => createHmac('sha256', secret()).update(v).digest('base64url');

export function creerJeton(compteId: string): string {
  const corps = `${compteId}.${Date.now()}`;
  return `${Buffer.from(corps).toString('base64url')}.${sign(corps)}`;
}

export function lireJeton(jeton?: string): string | null {
  if (!jeton || !jeton.includes('.')) return null;
  const i = jeton.lastIndexOf('.');
  const corps = Buffer.from(jeton.slice(0, i), 'base64url').toString();
  const sig = jeton.slice(i + 1);
  const attendu = sign(corps);
  if (sig.length !== attendu.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(attendu))) return null;
  const [id, ts] = corps.split('.');
  if (Date.now() - Number(ts) > 30 * 24 * 3600_000) return null;   // 30 jours
  return id || null;
}

/**
 * 🔴 CETTE FONCTION NE DOIT JAMAIS LEVER. `decodeURIComponent` refuse une
 * séquence d'échappement invalide (`%`, `%zz`) : un simple en-tête
 * `Cookie: veveid_sess=%` faisait tomber le PROCESSUS ENTIER — sans
 * authentification, et avant même le limiteur de débit. Une requête, un
 * service à terre. Un cookie illisible est simplement un cookie absent.
 */
export function lireCookie(entete: string | undefined, nom: string): string | undefined {
  for (const p of (entete ?? '').split(';')) {
    const [k, ...v] = p.trim().split('=');
    if (k !== nom) continue;
    const brut = v.join('=');
    try { return decodeURIComponent(brut); } catch { return brut; }
  }
  return undefined;
}

export const COOKIE = 'veveid_sess';
export const poserCookie = (jeton: string) =>
  `${COOKIE}=${encodeURIComponent(jeton)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}; Secure`;

// ── LA SESSION D'EXPLOITATION ─────────────────────────────────────────
/**
 * 🔴 UN JETON D'ADMIN NE DOIT PAS VOYAGER DANS L'URL.
 *
 * `/admin?k=…` le dépose dans l'historique du navigateur, dans les journaux
 * d'accès du serveur ET du reverse proxy, et dans l'en-tête `Referer` envoyé
 * à tout site vers lequel on cliquerait depuis cette page. Il survit donc
 * bien plus longtemps que la session, à des endroits qu'on ne pense jamais
 * à nettoyer. C'est un secret PERMANENT (il ne tourne pas) : chaque endroit
 * où il se dépose est une copie définitive.
 *
 * On l'échange donc une fois contre un COOKIE de session signé, puis on
 * nettoie l'URL par une redirection. Le cookie ne contient pas le jeton :
 * il contient une preuve, signée, qu'on l'a présenté — inutilisable ailleurs.
 *
 * ⭐ La signature est liée AU JETON LUI-MÊME : changer `ADMIN_TOKEN` invalide
 * d'un coup toutes les sessions ouvertes, ce qui est précisément ce qu'on
 * attend d'une rotation de secret.
 */
export const COOKIE_ADMIN = 'veveid_adm';
const DUREE_ADMIN_MS = 8 * 3600_000;   // une journée de travail, pas plus

/**
 * 🔴 LOT 108 — LE JETON D'EXPLOITATION, LU PARESSEUSEMENT (même piège que
 * `secret()` ci-dessus : un `const X = process.env.Y` s'évalue à l'IMPORT).
 *
 * ⛔ AUCUN REPLI. Si `ADMIN_TOKEN` est absent, cette fonction rend la chaîne
 *    vide et **la route `/admin` rend 404** — elle n'existe pas. Le repli
 *    tentant (« pas de jeton posé ⇒ on ouvre en local ») est exactement le
 *    repli qui ouvre : le jour où la variable est mal orthographiée dans
 *    Coolify, la page d'administration devient publique et rien ne le dit.
 *    Même raisonnement que le mode simulation du courriel.
 *
 * ⭐ 404 ET NON 401. Un « refusé » annonce qu'il y a quelque chose à
 *    trouver ; un 404 ne distingue pas « mauvais jeton » de « cette route
 *    n'existe pas sur ce service ».
 */
export const jetonAdmin = (): string => String(process.env.ADMIN_TOKEN ?? '').trim();

const signAdmin = (v: string, jetonAdmin: string) =>
  createHmac('sha256', secret() + '|' + jetonAdmin).update(v).digest('base64url');

export function creerJetonAdmin(jetonAdmin: string): string {
  const corps = String(Date.now());
  return `${corps}.${signAdmin(corps, jetonAdmin)}`;
}

export function lireJetonAdmin(cookie: string | undefined, jetonAdmin: string): boolean {
  if (!cookie || !jetonAdmin || !cookie.includes('.')) return false;
  const i = cookie.lastIndexOf('.');
  const corps = cookie.slice(0, i);
  const sig = cookie.slice(i + 1);
  const attendu = signAdmin(corps, jetonAdmin);
  if (sig.length !== attendu.length) return false;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(attendu))) return false;
  const ts = Number(corps);
  return Number.isFinite(ts) && Date.now() - ts < DUREE_ADMIN_MS;
}

export const poserCookieAdmin = (jeton: string) =>
  `${COOKIE_ADMIN}=${encodeURIComponent(jeton)}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${DUREE_ADMIN_MS / 1000}; Secure`;
/** SameSite=Strict : le cookie ne part JAMAIS depuis un autre site. */
export const effacerCookieAdmin = () =>
  `${COOKIE_ADMIN}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0`;
