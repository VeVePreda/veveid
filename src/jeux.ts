/**
 * ⭐⭐ LES JEUX AUTORISÉS — et pourquoi cette liste est une question de
 *    SÉCURITÉ, pas de configuration.
 *
 * 🔴 SANS ELLE, LE SERVICE EST UNE REDIRECTION OUVERTE. N'importe qui
 *    enverrait un joueur sur
 *      id.../connexion?jeu=loop&retour=https://chez-moi.example
 *    et récupérerait, dans son propre journal de serveur, un jeton
 *    d'identité valide pour ce joueur. La vérification de propriété tout
 *    entière ne vaudrait plus rien.
 *
 * ⚠️ ON COMPARE DES ORIGINES, PAS DES PRÉFIXES DE CHAÎNE. Un contrôle du
 *    genre `retour.startsWith(autorise)` laisse passer
 *    `https://loop.digitalcollectible.net.chez-moi.example` — un domaine
 *    qui appartient à l'attaquant et qui commence bien par le bon texte.
 *
 * Déclaration, dans la variable d'environnement `JEUX` :
 *   loop=https://loop.digitalcollectible.net,arcade=https://arcade.digitalcollectible.net
 */

export interface Jeu { id: string; origine: string }

let _jeux: Map<string, Jeu> | null = null;

/** ⚠️ Lecture PARESSEUSE : `process.env` lu à l'import arriverait trop tôt. */
export function jeux(): Map<string, Jeu> {
  if (_jeux) return _jeux;
  const m = new Map<string, Jeu>();
  for (const part of (process.env.JEUX ?? '').split(',')) {
    const [id, url] = part.split('=').map((x) => x?.trim());
    if (!id || !url) continue;
    try { m.set(id, { id, origine: new URL(url).origin }); }
    catch { console.warn(`[jeux] adresse illisible pour « ${id} » : ${url}`); }
  }
  if (!m.size) console.warn('[jeux] AUCUN jeu déclaré — la variable JEUX est vide.');
  _jeux = m;
  return m;
}

/** Réservé aux tests : relit la configuration. */
export const oublierJeux = () => { _jeux = null; };

export const jeuConnu = (id: string) => jeux().has(id);

/**
 * L'adresse de retour est-elle légitime pour ce jeu ?
 *
 * On accepte n'importe quel chemin **sur l'origine déclarée**, et rien
 * d'autre. Cela laisse au jeu la liberté de choisir sa page d'arrivée sans
 * ouvrir la moindre porte.
 */
export function retourAutorise(jeuId: string, retour: string): boolean {
  const j = jeux().get(jeuId);
  if (!j) return false;
  try { return new URL(retour).origin === j.origine; }
  catch { return false; }
}

/** L'adresse d'arrivée par défaut d'un jeu, quand aucune n'est fournie. */
export const origineDe = (jeuId: string) => jeux().get(jeuId)?.origine ?? null;
