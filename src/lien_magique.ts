import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { q, q1, run, now } from './db.ts';

/**
 * ⭐⭐ LE LIEN DE CONNEXION — la porte d'entrée du service depuis le lot 89.
 *
 * 🔴 CE QUI A CHANGÉ, ET POURQUOI. Jusqu'ici, `creerOuLireCompte(wallet)`
 *    était LA seule porte : un compte sans portefeuille VeVe était
 *    littéralement impossible à créer. Or la plupart des visiteurs de
 *    veveprice.com n'ont pas de portefeuille VeVe. Adosser l'inscription à
 *    la preuve de propriété, c'était la refuser à la majorité des abonnés
 *    possibles.
 *
 *    Le portefeuille reste — mais APRÈS, depuis « Mon compte », comme une
 *    invitation. Jamais comme un mur.
 *
 * ⭐ LE PORTEFEUILLE N'EST PAS UNE IDENTITÉ, C'EST UNE PREUVE. On garde
 *    donc les deux : l'e-mail dit QUI, le portefeuille dit CE QU'ON
 *    DÉTIENT. Les mélanger obligeait à posséder pour exister.
 */

/** ⚠️ Quinze minutes : assez pour aller chercher le message, trop court
 *  pour qu'un lien traîne utilement dans une boîte partagée. */
export const DUREE_MIN = 15;

/** Au plus trois demandes pour une même adresse dans la fenêtre. */
export const MAX_PAR_FENETRE = 3;
const FENETRE_MS = 15 * 60_000;

/**
 * ⭐ L'empreinte, jamais le jeton. Voir le commentaire de la table `liens`
 *    dans db.ts : une copie de la base ne doit ouvrir aucun compte.
 */
const empreinteDe = (jeton: string) => createHash('sha256').update(jeton).digest('hex');

/**
 * ⚠️ 32 OCTETS, TIRÉS PAR `randomBytes`. Pas `Math.random()`, qui est
 *    prévisible dès qu'on en a vu quelques valeurs — et ici « prévoir »
 *    veut dire « entrer dans le compte de quelqu'un d'autre ».
 */
const nouveauJeton = () => randomBytes(32).toString('base64url');

/**
 * Normalisation de l'adresse.
 *
 * ⛔ ON NE FAIT QUE MINUSCULE + ESPACES. La tentation suivante est de
 *    « normaliser Gmail » (retirer les points, couper au +). Ce serait
 *    décider à la place d'un fournisseur : chez d'autres, `a.b@` et `ab@`
 *    sont deux personnes différentes, et on fusionnerait deux comptes.
 *    Une règle vraie ligne par ligne peut produire un ensemble faux.
 */
export const normaliser = (email: string) => String(email ?? '').trim().toLowerCase();

/**
 * ⚠️ ON NE VALIDE PAS UNE ADRESSE PAR EXPRESSION RÉGULIÈRE, ON LA REFUSE
 *    QUAND ELLE EST MANIFESTEMENT IMPOSSIBLE. La grammaire réelle d'une
 *    adresse (RFC 5322) accepte des choses que personne n'écrit et que
 *    toute regex « stricte » rejette à tort. La seule preuve qu'une adresse
 *    existe, c'est qu'un message y arrive — et c'est exactement ce que fait
 *    la suite. On écarte donc le vide, l'espace, l'absence d'arobase et le
 *    domaine sans point, rien de plus.
 */
export function adressePlausible(email: string): boolean {
  const e = normaliser(email);
  if (!e || e.length > 254 || /\s/.test(e)) return false;
  const at = e.lastIndexOf('@');
  if (at < 1 || at === e.length - 1) return false;
  const domaine = e.slice(at + 1);
  return domaine.includes('.') && !domaine.startsWith('.') && !domaine.endsWith('.');
}

export interface Demande { jeton?: string; erreur?: string }

/**
 * Fabrique un lien pour cette adresse. Ne l'envoie pas : l'envoi est le
 * métier de `courriel.ts`, et les séparer permet de tester celui-ci sans
 * réseau.
 */
/**
 * 🔴🔴 OPTIONS NOMMÉES, ET C'EST UN BANC ROUGE QUI L'A IMPOSÉ.
 *
 * La première version de ce lot était `demander(email, retour, maintenant)`.
 * Les appels existants s'écrivaient `demander(email, t0)` — et `t0`, un
 * nombre, est allé se ranger dans `retour`, c'est-à-dire dans le champ qui
 * décide OÙ LA PERSONNE EST RENVOYÉE après avoir cliqué. Aucune erreur :
 * la valeur était simplement absurde, et `maintenant` retombait sur
 * `Date.now()`, ce qui faisait échouer un test de fenêtre temporelle très
 * loin de la cause.
 *
 * ⭐⭐ UN PARAMÈTRE AJOUTÉ **AU MILIEU** D'UNE SIGNATURE NE CASSE PAS LES
 *     APPELS EXISTANTS : IL LES DÉCALE. C'est un changement silencieux
 *     dans un champ de sécurité. Nommer les options rend la confusion
 *     impossible à écrire.
 */
export interface Options { retour?: string | null; maintenant?: number }

export function demander(email: string, o: Options = {}): Demande {
  const maintenant = o.maintenant ?? Date.now();
  const e = normaliser(email);
  if (!adressePlausible(e)) return { erreur: 'Cette adresse ne ressemble pas à une adresse e-mail.' };

  /**
   * ⚠️ DÉFENSE EN PROFONDEUR. `retour` est déjà vérifié par
   *    `retourAutorise()` chez l'appelant ; ce garde-ci ne le remplace pas,
   *    il refuse ce qui n'est même pas une adresse. C'est lui qui aurait
   *    crié tout de suite sur le décalage décrit plus haut, au lieu de
   *    laisser un nombre s'écrire dans la base.
   */
  let retour: string | null = null;
  if (o.retour != null && o.retour !== '') {
    const brut = String(o.retour);
    let bonneForme = false;
    try { const u = new URL(brut); bonneForme = u.protocol === 'https:' || u.protocol === 'http:'; }
    catch { bonneForme = false; }
    if (!bonneForme) return { erreur: `Adresse de retour illisible : ${brut.slice(0, 60)}` };
    retour = brut;
  }

  const depuis = new Date(maintenant - FENETRE_MS).toISOString();
  const recents = q<{ n: number }>('SELECT COUNT(*) AS n FROM liens WHERE email=? AND cree > ?', e, depuis)[0]?.n ?? 0;
  if (recents >= MAX_PAR_FENETRE)
    return { erreur: `Trop de liens demandés pour cette adresse. Réessayez dans ${DUREE_MIN} minutes.` };

  const jeton = nouveauJeton();
  /**
   * 🔴 `retour` EST DÉJÀ VÉRIFIÉ QUAND IL ARRIVE ICI (`retourAutorise()`,
   *    dans server.ts). On l'écrit tel quel, et c'est volontaire : une
   *    adresse contrôlée À L'ENTRÉE ne peut plus devenir mauvaise à la
   *    sortie. Le contrôler au moment de la redirection donnerait deux
   *    endroits où la même règle peut diverger — et c'est toujours celui
   *    qu'on a oublié qui sert.
   */
  run('INSERT INTO liens (empreinte, email, cree, expire, retour) VALUES (?,?,?,?,?)',
    empreinteDe(jeton), e, new Date(maintenant).toISOString(),
    new Date(maintenant + DUREE_MIN * 60_000).toISOString(), retour);
  return { jeton };
}

export interface Verdict { email?: string; retour?: string | null; pourquoi?: string }

/**
 * 🔴🔴 LA CONSOMMATION EST **ATOMIQUE**, ET C'EST TOUT L'INTÉRÊT DE CETTE
 *      FONCTION.
 *
 * La version évidente — lire la ligne, vérifier qu'elle n'est pas
 * consommée, puis écrire `consomme_le` — laisse passer DEUX clics arrivés
 * dans le même souffle : les deux lisent « pas encore consommé » avant que
 * l'un ait écrit. Ce n'est pas théorique : un antivirus ou un aperçu de
 * lien dans une messagerie visite l'adresse avant l'humain, et l'humain
 * clique une seconde plus tard.
 *
 * On écrit donc D'ABORD, sous condition, et on regarde COMBIEN DE LIGNES
 * ont changé. `changes === 1` est la preuve qu'on est le seul à avoir
 * réussi ; `0` veut dire déjà consommé, périmé, ou inexistant — et on ne
 * dit pas lequel.
 *
 * ⚠️ ON NE DISTINGUE PAS « INCONNU » DE « DÉJÀ UTILISÉ » dans le message
 *    rendu au visiteur. La différence renseignerait un curieux sur ce qui
 *    a existé.
 */
export function consommer(jeton: string, maintenant = Date.now()): Verdict {
  if (!jeton || typeof jeton !== 'string') return { pourquoi: 'Ce lien n’est plus valable.' };
  const empreinte = empreinteDe(jeton);
  const instant = new Date(maintenant).toISOString();
  const r = run(
    'UPDATE liens SET consomme_le=? WHERE empreinte=? AND consomme_le IS NULL AND expire > ?',
    instant, empreinte, instant,
  );
  if (Number(r.changes) !== 1) return { pourquoi: 'Ce lien n’est plus valable : il a expiré ou il a déjà servi.' };
  const l = q1<{ email: string; retour: string | null }>('SELECT email, retour FROM liens WHERE empreinte=?', empreinte);
  if (!l) return { pourquoi: 'Ce lien n’est plus valable.' };
  return { email: l.email, retour: l.retour };
}

/**
 * Ménage. ⚠️ On garde les liens CONSOMMÉS un moment : c'est ce qui permet
 * de répondre « déjà utilisé » plutôt que « inconnu » au deuxième clic, et
 * de voir, en cas d'incident, qu'un lien a bien servi une fois.
 */
export function purgerLiens(maintenant = Date.now()): number {
  const limite = new Date(maintenant - 7 * 86_400_000).toISOString();
  return Number(run('DELETE FROM liens WHERE cree < ?', limite).changes ?? 0);
}

/**
 * Comparaison à durée constante — pour les usages où un jeton fourni est
 * comparé à un jeton connu. Exportée ici pour que rien, dans ce module,
 * n'invite à écrire `===` sur un secret.
 */
export function memeJeton(a: string, b: string): boolean {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}
