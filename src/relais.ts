import { createHash, randomBytes } from 'node:crypto';
import { q1, run } from './db.ts';

/**
 * ⭐⭐⭐ LE RELAIS — arriver ICI depuis une session déjà ouverte sur un site.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * POURQUOI IL EXISTE
 * ═══════════════════════════════════════════════════════════════════════
 * Le parcours de preuve de propriété (choisir deux collectibles, les
 * lister, la chaîne confirme) vit sur CE service. Il y a été REMONTÉ le
 * 20/07/2026 depuis Loop, parce qu'il était déjà écrit deux fois — dans
 * MightysArena et dans Loop — et allait l'être une troisième.
 * ⛔ Le recopier dans veveprice serait la troisième fois.
 *
 * ⭐ Mais un membre connecté sur veveprice n'a AUCUNE session ici : les
 *   deux cookies sont sur deux domaines et ne se voient pas. Sans relais,
 *   on lui demanderait de redemander un lien par courriel pour entrer
 *   dans un parcours qu'il vient de lancer d'un clic. C'est le genre de
 *   marche qui fait abandonner.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * 🔴 CE QUE CE JETON N'EST PAS
 * ═══════════════════════════════════════════════════════════════════════
 * Ce n'est PAS le `code` de `sessions.ts`. Les deux se ressemblent — une
 * valeur à usage unique, soixante secondes, dans une URL — et c'est
 * précisément pourquoi il faut écrire la différence noir sur blanc :
 *
 *     codes   : veveid → le SITE  ·  ouvre une session sur veveprice
 *     relais  : le SITE → veveid  ·  ouvre une session ICI
 *
 * ⛔ UN SEUL JETON QUI OUVRIRAIT LES DEUX PORTES SERAIT UNE ÉLÉVATION DE
 *   PRIVILÈGE DÉGUISÉE EN ÉCONOMIE DE CODE : le site n'a pas à pouvoir
 *   fabriquer une session sur le service d'identité à partir de ce qu'il
 *   a déjà en main. Il doit la DEMANDER, avec son secret de service, pour
 *   un `sid` qu'il possède — et c'est veveid qui décide.
 *
 * ⭐ L'empreinte, jamais le secret. Une base lue ne rend aucun jeton
 *   utilisable — même règle que les liens de connexion et les sessions.
 */

/**
 * 🔴 SOIXANTE SECONDES, comme le code d'échange, et pour la même raison :
 *    c'est la seule chose de ce dispositif qui traverse une barre
 *    d'adresse. Elle atterrit dans l'historique, dans les journaux du
 *    proxy et dans le `Referer` du premier lien cliqué ensuite. Ici la
 *    personne clique et arrive : une minute couvre un réseau lent, pas
 *    davantage.
 */
export const DUREE_RELAIS_S = 60;

/**
 * ⚠️ LA DESTINATION EST UNE LISTE FERMÉE, PAS UNE ADRESSE.
 *
 * La tentation était d'accepter `vers=/n-importe-quoi` — « c'est le site
 * qui sait où il envoie ». Ce serait faire de cette route une REDIRECTION
 * OUVERTE authentifiée : quiconque obtiendrait le secret de service
 * pourrait fabriquer un lien `id.digitalcollectible.net/…` qui envoie
 * ailleurs, et il porterait notre domaine.
 * ⭐ Deux valeurs suffisaient, et la troisième s'est ajoutée ici — en une
 *   ligne, sous les yeux de qui relit. C'était le contrat.
 *
 * 🔴 UNE ENTRÉE DE PLUS N'EST PAS UNE LIGNE DE PLUS. Une destination qui
 *    ne correspond à aucune route SERVIE ne lève rien : le relais
 *    consomme le jeton, pose le cookie, redirige — et le serveur renvoie
 *    vers l'accueil. La personne est connectée, et elle est revenue au
 *    point de départ. `test/relais.test.ts` réclame donc que CHAQUE valeur
 *    de cette table soit une route réelle de `server.ts`, celles d'après
 *    comprises.
 */
export const DESTINATIONS: Record<string, string> = {
  compte: '/compte',
  // Le parcours de vérification. `/choisir` renvoie de lui-même vers
  // `/compte` s'il n'y a pas encore de portefeuille — on ne duplique donc
  // pas cette règle ici.
  verifier: '/choisir',
  /**
   * 🔥 LOT 141 — LE PARCOURS QUI NE DEMANDE PAS D'ADRESSE.
   *
   * ⭐⭐ POURQUOI UNE TROISIÈME ENTRÉE PLUTÔT QU'UNE RÈGLE DANS `verifier`.
   *   `/choisir` sait déjà se renvoyer vers `/compte` quand il n'y a pas
   *   de portefeuille — mais un renvoi n'est pas une orientation : il
   *   dépose la personne sur une page d'où il faut RE-CLIQUER, et le clic
   *   qu'elle vient de faire disait déjà où elle allait. Le site, lui,
   *   SAIT si le portefeuille est vérifié avant d'ouvrir le relais. C'est
   *   donc à l'appelant de nommer le parcours, pas à `/choisir` de le
   *   deviner une page trop tard.
   *
   * ⛔ Et `verifier` reste : ce sont deux parcours différents, pas deux
   *   versions du même. Qui connaît son adresse va droit à la preuve.
   */
  decouvrir: '/decouvrir',
};

const empreinteDe = (s: string) => createHash('sha256').update(s).digest('hex');

export function creerRelais(compteId: string, vers: string, maintenant = Date.now()): string | null {
  if (!DESTINATIONS[vers]) return null;
  const jeton = randomBytes(32).toString('base64url');
  run('INSERT INTO relais (empreinte, compte_id, vers, cree, expire) VALUES (?,?,?,?,?)',
    empreinteDe(jeton), compteId, vers,
    new Date(maintenant).toISOString(),
    new Date(maintenant + DUREE_RELAIS_S * 1000).toISOString());
  return jeton;
}

export interface Passage { compteId?: string; chemin?: string; pourquoi?: string }

/**
 * 🔴 CONSOMMATION ATOMIQUE — `UPDATE … WHERE consomme_le IS NULL` puis
 *    `changes === 1`, exactement comme le lien de connexion et le code
 *    d'échange. Un `SELECT` puis un `UPDATE` laisse une fenêtre où deux
 *    requêtes simultanées passent toutes les deux : deux sessions ouvertes
 *    pour un seul clic, dont une que personne ne saurait avoir laissée.
 *    ⭐ Le lien du courriel double-cliqué n'est pas un cas théorique.
 */
export function consommerRelais(jeton: string, maintenant = Date.now()): Passage {
  if (!jeton || typeof jeton !== 'string') return { pourquoi: 'lien invalide' };
  const instant = new Date(maintenant).toISOString();
  const emp = empreinteDe(jeton);
  const r = run('UPDATE relais SET consomme_le=? WHERE empreinte=? AND consomme_le IS NULL AND expire > ?',
    instant, emp, instant);
  if (Number(r.changes) !== 1) return { pourquoi: 'lien expiré ou déjà utilisé' };
  const l = q1<{ compte_id: string; vers: string }>('SELECT compte_id, vers FROM relais WHERE empreinte=?', emp);
  if (!l) return { pourquoi: 'lien invalide' };
  return { compteId: l.compte_id, chemin: DESTINATIONS[l.vers] ?? DESTINATIONS.compte };
}

/** Ménage : les jetons d'une minute n'ont rien à faire en base une semaine. */
export const purgerRelais = (maintenant = Date.now()): number =>
  Number(run('DELETE FROM relais WHERE cree < ?',
    new Date(maintenant - 86_400_000).toISOString()).changes ?? 0);
