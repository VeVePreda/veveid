/**
 * Limiteur de débit, en mémoire, sans dépendance.
 * ⚠️ RAISON D'ÊTRE : /verifier interroge CollectScan (jusqu'à 4 requêtes).
 * Quelqu'un qui martèle la route ferait bloquer NOTRE adresse par
 * l'explorateur — et la preuve de propriété, donc le produit entier,
 * cesserait de fonctionner. On se protège d'abord de ça.
 */
interface Seau { jetons: number; dernier: number }
const seaux = new Map<string, Seau>();

export interface Regle { max: number; parMs: number }
export const REGLES = {
  verifier: { max: 5, parMs: 10 * 60_000 },    // 5 lectures de portefeuille / 10 min
  api: { max: 120, parMs: 60_000 },            // sondage du défi : 1 toutes les 20 s
  general: { max: 240, parMs: 60_000 },
  /**
   * 🔴 PLAFOND ABSOLU, TOUS VISITEURS CONFONDUS. Un limiteur par adresse
   * ne protège de rien si l'adresse est déclarée par le client : il suffit
   * d'en changer à chaque requête. Ce seau-ci n'est indexé sur personne —
   * c'est le vrai garde-fou de notre quota chez l'explorateur de chaîne.
   */
  verifierGlobal: { max: 60, parMs: 10 * 60_000 },
  apiGlobal: { max: 900, parMs: 60_000 },
  /** Fabrication d'images : la route la plus chère du service. */
  carte: { max: 40, parMs: 60_000 },
  carteGlobal: { max: 300, parMs: 60_000 },
  /**
   * 🔥 LOT 108 — L'EXPLOITATION.
   * ⚠️ Ce plafond ne protège pas d'une force brute sur `ADMIN_TOKEN` : 24
   *    octets tirés au hasard ne se devinent pas, et un plafond ne change
   *    rien à ça. Ce qu'il borne, c'est **la recherche** : elle répond
   *    « ce compte existe » à qui présente une adresse, donc elle ne doit
   *    jamais devenir une moulinette sur une liste d'adresses achetée —
   *    même derrière le jeton, même par mégarde.
   */
  admin: { max: 30, parMs: 60_000 },
} satisfies Record<string, Regle>;

export function autorise(cle: string, r: Regle, maintenant = Date.now()): boolean {
  const s = seaux.get(cle);
  if (!s) { seaux.set(cle, { jetons: r.max - 1, dernier: maintenant }); return true; }
  const recharge = ((maintenant - s.dernier) / r.parMs) * r.max;
  s.jetons = Math.min(r.max, s.jetons + recharge);
  s.dernier = maintenant;
  if (s.jetons < 1) return false;
  s.jetons -= 1;
  return true;
}

export function purgerSeaux(maintenant = Date.now()): void {
  for (const [k, s] of seaux) if (maintenant - s.dernier > 3600_000) seaux.delete(k);
}

/**
 * 🔴 UN EN-TÊTE N'EST PAS UNE PREUVE. `CF-Connecting-IP` et
 * `X-Forwarded-For` sont écrits par le CLIENT tant que l'origine est
 * joignable en direct : les croire revient à offrir un limiteur qu'on
 * contourne en changeant un octet. Mesuré : 5 requêtes bloquées sur une
 * même adresse, 8 sur 8 passées avec un en-tête tiré au hasard.
 *
 * On ne les lit donc QUE si `TRUST_PROXY=1` — à ne poser qu'une fois le
 * pare-feu en place, c'est-à-dire quand l'origine n'accepte plus QUE les
 * adresses de Cloudflare. Sans cette variable, on s'en tient à l'adresse
 * de la connexion, qui, elle, ne se falsifie pas.
 */
export const derriereProxy = () => process.env.TRUST_PROXY === '1';

/**
 * 🔴 LIRE UN NOMBRE DE CONFIGURATION SANS SE FAIRE PIÉGER.
 *
 * `Number('abc')` vaut NaN, et `setInterval(fn, NaN)` retombe à 1 ms :
 * mesuré, 855 déclenchements par seconde. Une simple faute de frappe sur
 * `SYNC_INTERVAL_MS` transformait le service en marteau contre
 * l'explorateur de chaîne — et c'est NOTRE adresse qui aurait été
 * bloquée, donc la preuve de propriété pour tout le monde.
 *
 * On refuse donc silencieusement l'absurde : valeur non numérique ou hors
 * bornes -> on garde le défaut, et on le DIT dans le journal.
 */
export function nombreEnv(nom: string, defaut: number, min: number, max: number): number {
  const brut = process.env[nom];
  if (brut === undefined || brut === '') return defaut;
  const v = Number(brut);
  if (!Number.isFinite(v) || v < min || v > max) {
    console.warn(`[config] ${nom}="${brut}" ignoré (attendu un nombre entre ${min} et ${max}) → ${defaut}`);
    return defaut;
  }
  return v;
}

export function adresse(entetes: Record<string, string | string[] | undefined>, secours?: string): string {
  if (derriereProxy()) {
    const cf = entetes['cf-connecting-ip'];
    if (typeof cf === 'string' && cf) return cf;
    const xff = entetes['x-forwarded-for'];
    if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  }
  return secours ?? 'inconnu';
}
export const compteurs = () => seaux.size;
