import { createHash, randomBytes } from 'node:crypto';
import { q1, run, now } from './db.ts';
import { lireCompte, paliDe } from './avoirs.ts';

/**
 * ⭐⭐ LES SESSIONS DE veveprice — et pourquoi elles vivent ICI.
 *
 * 🔴 LE MIDDLEWARE DE veve-sites NE FAIT PAS L'AUTHENTIFICATION, il ne
 *    fait que LIRE un palier :
 *        GET {SESSION_API}/session/<sid>  ->  { "palier": "member" }
 *    Son commentaire dit pourquoi il échoue fermé, et il a raison. Il
 *    manquait simplement quelqu'un au bout du fil.
 *
 * ⭐ POURQUOI veveid PLUTÔT QUE veveprice. C'est veveid qui connaît
 *    l'abonnement (`abonne_jusqu_a`). Un palier recopié dans un cookie
 *    signé par veveprice serait FIGÉ jusqu'à son expiration : un
 *    abonnement annulé continuerait d'ouvrir les portes pendant trente
 *    jours. Ici, la révocation est immédiate — on efface une ligne.
 *
 * ⚠️ LE COÛT, ET IL EST RÉEL : un appel réseau par page rendue à la
 *    demande. Il n'y en a que neuf sur veveprice, les ~8 500 pages de
 *    contenu restent pré-générées et ne passent pas par là. Le middleware
 *    a déjà posé son délai maximum à 1,5 s et échoue fermé au-delà.
 */

/** Trente jours — la même durée que le cookie de veveid. */
export const DUREE_SESSION_J = 30;

/**
 * 🔴 SOIXANTE SECONDES POUR LE CODE D'ÉCHANGE, ET C'EST LONG.
 *
 * Le code est la SEULE chose de ce dispositif qui voyage dans une URL —
 * donc dans l'historique du navigateur, dans les journaux du serveur et
 * du proxy, et dans l'en-tête `Referer` de tout lien cliqué ensuite. Il
 * est échangé par veveprice CÔTÉ SERVEUR, dans la seconde qui suit la
 * redirection. Une minute couvre un réseau lent ; au-delà, on ne couvre
 * plus que le risque.
 *
 * ⭐ LE `sid`, LUI, NE PASSE JAMAIS PAR UNE URL. C'est tout l'objet de ce
 *    détour : sans le code, il faudrait mettre l'identifiant de session
 *    dans la redirection, et il resterait là où on ne pense jamais à
 *    nettoyer.
 */
export const DUREE_CODE_S = 60;

/** ⭐ L'empreinte, jamais le secret. Même raison que pour les liens. */
const empreinteDe = (s: string) => createHash('sha256').update(s).digest('hex');
const nouveauSecret = () => randomBytes(32).toString('base64url');

// ── Le code d'échange ──────────────────────────────────────────────────

export function creerCode(compteId: string, maintenant = Date.now()): string {
  const code = nouveauSecret();
  run('INSERT INTO codes (empreinte, compte_id, cree, expire) VALUES (?,?,?,?)',
    empreinteDe(code), compteId, new Date(maintenant).toISOString(),
    new Date(maintenant + DUREE_CODE_S * 1000).toISOString());
  return code;
}

export interface Echange { sid?: string; compte?: string; email?: string | null; palier?: string; pourquoi?: string }

/**
 * 🔴 CONSOMMATION ATOMIQUE, exactement comme le lien de connexion :
 *    `UPDATE … WHERE consomme_le IS NULL` puis `changes === 1`. Deux
 *    échanges du même code ouvriraient DEUX sessions valides pour un seul
 *    passage — dont une que personne ne saurait avoir laissée ouverte.
 */
export function echanger(code: string, maintenant = Date.now()): Echange {
  if (!code || typeof code !== 'string') return { pourquoi: 'code invalide' };
  const instant = new Date(maintenant).toISOString();
  const emp = empreinteDe(code);
  const r = run('UPDATE codes SET consomme_le=? WHERE empreinte=? AND consomme_le IS NULL AND expire > ?',
    instant, emp, instant);
  if (Number(r.changes) !== 1) return { pourquoi: 'code invalide' };

  const l = q1<{ compte_id: string }>('SELECT compte_id FROM codes WHERE empreinte=?', emp);
  const c = l && lireCompte(l.compte_id);
  if (!c) return { pourquoi: 'code invalide' };

  const sid = ouvrirSession(c.id, maintenant);
  return { sid, compte: c.id, email: c.email, palier: paliDe(c) };
}

// ── La session ─────────────────────────────────────────────────────────

export function ouvrirSession(compteId: string, maintenant = Date.now()): string {
  const sid = nouveauSecret();
  run('INSERT INTO sessions (empreinte, compte_id, cree, expire) VALUES (?,?,?,?)',
    empreinteDe(sid), compteId, new Date(maintenant).toISOString(),
    new Date(maintenant + DUREE_SESSION_J * 86_400_000).toISOString());
  return sid;
}

export interface Etat { palier?: string; compte?: string; email?: string | null }

/**
 * ⭐⭐ CETTE ROUTE EST **PUBLIQUE**, ET C'EST UN CHOIX QUI S'ASSUME.
 *
 * Le middleware de veve-sites n'envoie PAS `x-service` — il n'a pas de
 * secret à porter, il tourne dans un processus qui rend des pages. Ce qui
 * protège cette lecture, c'est que le `sid` est un secret de 256 bits
 * tiré au hasard : le deviner n'est pas plus faisable que de deviner un
 * mot de passe de trente-deux octets.
 *
 * ⚠️ ELLE NE REND QUE LE PALIER, PAS LE COMPTE. Un palier ne dit rien de
 *    personne. Si un jour on lui fait rendre l'adresse e-mail « pour
 *    afficher le nom dans l'en-tête », il faudra la fermer par un secret
 *    partagé — parce qu'elle cessera de ne rien révéler.
 *
 * ⭐ LE PALIER SE RECALCULE À CHAQUE LECTURE, il n'est pas stocké dans la
 *    session. C'est ce qui fait qu'un abonnement qui expire ferme la
 *    porte à la requête suivante, sans qu'on ait à parcourir les sessions.
 */
export function etatDeLaSession(sid: string, maintenant = Date.now()): Etat {
  if (!sid || typeof sid !== 'string') return {};
  const instant = new Date(maintenant).toISOString();
  const s = q1<{ compte_id: string }>(
    'SELECT compte_id FROM sessions WHERE empreinte=? AND revoquee_le IS NULL AND expire > ?',
    empreinteDe(sid), instant);
  if (!s) return {};
  const c = lireCompte(s.compte_id);
  if (!c) return {};
  /**
   * ⚠️ UNE SUPPRESSION DEMANDÉE FERME LA PORTE TOUT DE SUITE. Le délai de
   *    grâce de sept jours sert à REVENIR sur sa décision, pas à continuer
   *    d'utiliser le service en attendant l'effacement.
   */
  if (c.supprime_le) return {};
  run('UPDATE sessions SET vue_le=? WHERE empreinte=?', instant, empreinteDe(sid));
  return { palier: paliDe(c), compte: c.id, email: c.email };
}

export function revoquer(sid: string): boolean {
  if (!sid) return false;
  const r = run('UPDATE sessions SET revoquee_le=? WHERE empreinte=? AND revoquee_le IS NULL', now(), empreinteDe(sid));
  return Number(r.changes) === 1;
}

/** Toutes les sessions d'un compte — pour la suppression et le support. */
export const revoquerTout = (compteId: string): number =>
  Number(run('UPDATE sessions SET revoquee_le=? WHERE compte_id=? AND revoquee_le IS NULL', now(), compteId).changes ?? 0);

/**
 * Ménage. ⚠️ On efface les sessions PÉRIMÉES, pas les révoquées récentes :
 * savoir qu'une session a été fermée volontairement aide le jour où
 * quelqu'un demande « pourquoi ai-je été déconnecté ».
 */
export function purgerSessions(maintenant = Date.now()): number {
  const vieux = new Date(maintenant - 7 * 86_400_000).toISOString();
  const instant = new Date(maintenant).toISOString();
  const a = Number(run('DELETE FROM sessions WHERE expire < ? OR (revoquee_le IS NOT NULL AND revoquee_le < ?)', instant, vieux).changes ?? 0);
  const b = Number(run('DELETE FROM codes WHERE cree < ?', vieux).changes ?? 0);
  return a + b;
}
