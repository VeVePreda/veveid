/**
 * 🔥 LOT 107 — LE SITE EST UNE DONNÉE DU MODÈLE, PLUS UN IMPLICITE.
 *
 * 🔴 L'ARBITRAGE DE PREDA (07/08/2026), mot pour mot :
 *    « il faut prouver sur chaque site qu'on est bien le propriétaire du
 *      wallet. Pas de liens entre les sites, seulement ce service est présent
 *      sur les sites disposant d'un espace membre. »
 *
 * ⚠️ CE QUE ÇA RETIRE, ET IL FAUT LE SAVOIR : l'argument n°1 d'existence de ce
 *    service était « l'utilisateur ne prouve QU'UNE FOIS ». Ce n'est plus vrai.
 *    Ce qui reste — et qui suffit à le justifier — c'est qu'il est le SEUL à
 *    lire la chaîne : un quota, un code, une vérité par site.
 *    ⛔ Ne pas relitiger : c'est tranché.
 *
 * ⭐⭐ LE REGISTRE DES SITES EXISTE DÉJÀ, IL S'APPELLE `JEUX`. C'est la liste
 *    blanche d'origines (`jeux.ts`), et elle porte exactement ce qu'il faut :
 *    un identifiant et une origine. ⛔ On ne la renomme PAS — la variable
 *    d'environnement est posée en production sur Coolify, et renommer une
 *    variable qu'on ne peut pas relire d'ici est le genre de geste qui casse
 *    en silence au redémarrage suivant.
 *
 * ⭐ `SITE_DEFAUT` — le site auquel appartiennent les comptes déjà existants,
 *    et celui qu'on suppose quand l'appelant ne le dit pas. Aujourd'hui il n'y
 *    a qu'un site à espace membre : `veveprice`. Le jour où il y en a deux, ce
 *    défaut cesse d'être suffisant — et c'est `siteDeLAppelant()` qui devra
 *    être renseigné partout, pas ce défaut qu'il faudra changer.
 */
import { jeux } from './jeux.ts';

export const SITE_DEFAUT = () => (process.env.SITE_DEFAUT || 'veveprice').trim().toLowerCase();

/** Les sites connus = la liste blanche. Un site inconnu n'existe pas. */
export const siteConnu = (s: string) => jeux().has(String(s ?? '').trim().toLowerCase());

/**
 * ⛔ ON NE FAIT PAS CONFIANCE À UNE CHAÎNE VENUE DE L'EXTÉRIEUR. Un site non
 * déclaré retombe sur le défaut au lieu de créer un cloisonnement fantôme :
 * un compte rangé sous `site='chez-moi'` serait invisible pour tout le monde,
 * y compris pour son propriétaire, et rien ne le dirait.
 * ⚠️ Et on le DIT dans le journal : un appelant qui envoie un site inconnu est
 *    une erreur de configuration, pas un cas normal.
 */
export function normaliserSite(s: unknown): string {
  const v = String(s ?? '').trim().toLowerCase();
  if (!v) return SITE_DEFAUT();
  if (!siteConnu(v)) {
    console.warn(`[sites] « ${v} » n'est pas dans JEUX — compte rangé sous ${SITE_DEFAUT()}.`);
    return SITE_DEFAUT();
  }
  return v;
}

/**
 * ⭐ Le site d'une adresse de retour. C'est par là que le lien magique retrouve
 * son site : le courriel ne porte pas d'en-tête, mais il porte l'adresse où la
 * personne revient — et cette origine est dans la liste blanche.
 */
export function siteDeLOrigine(url: string | null | undefined): string | null {
  if (!url) return null;
  let origine: string;
  try { origine = new URL(url).origin; } catch { return null; }
  for (const [id, j] of jeux()) if (j.origine === origine) return id;
  return null;
}
