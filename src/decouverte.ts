import { randomUUID } from 'node:crypto';
import { q1, run, now } from './db.ts';
import {
  fetchEntreesEscrow, chaineDisponible, type EntreeEscrow, type FluxEscrow,
} from './collectchain.ts';

/**
 * ⭐⭐⭐ TROUVER LE PORTEFEUILLE SANS JAMAIS DEMANDER L'ADRESSE — lot 106.
 *
 * 🔴 LE PROBLÈME, POSÉ PAR PREDA : « la personne ne connaît pas son adresse de
 *    wallet, elle ne connaît que son nom d'utilisateur VeVe et le mint de ses
 *    items. C'est à nous de nous débrouiller pour lui faciliter la vie. »
 *    Et il a raison : le champ d'inscription lui demandait la seule chose
 *    qu'elle n'a pas. Personne ne finissait son inscription.
 *
 * ⭐⭐⭐ LA TROUVAILLE : LA DÉCOUVERTE ET LA PREUVE SONT LE MÊME GESTE.
 *    On lit l'ESCROW — adresse publique et unique où atterrit toute mise en
 *    vente — au lieu de lire un portefeuille. Chaque ligne porte le `from` du
 *    vendeur. La personne déclare DEUX de ses objets (nom + n° de mint), les
 *    liste, on les retrouve dans le flux : les deux `from` doivent être
 *    IDENTIQUES, et cette adresse EST son portefeuille.
 *
 * ⭐ C'est plus SÛR que l'ancien parcours. Avant, on faisait confiance à une
 *    adresse tapée puis on vérifiait. Ici l'adresse SORT de la preuve :
 *    personne ne peut réserver le portefeuille d'un autre en le tapant.
 *
 * ── 🔴🔴 CE QUI PORTE TOUTE LA SÉCURITÉ, ET IL FAUT LE SAVOIR ─────────────
 *
 * Le flux de l'escrow est PUBLIC. N'importe qui peut y lire, en direct, les
 * paires (nom, édition) que d'autres viennent de lister — et les recopier
 * pour se faire attribuer LEUR portefeuille.
 *
 * ⛔ Ce qui l'empêche n'est pas un contrôle : c'est L'ORDRE DES GESTES.
 *    La déclaration est SCELLÉE À L'INSTANT t0, et **seuls les dépôts
 *    POSTÉRIEURS à t0 comptent**. Un imposteur devrait donc deviner AVANT
 *    qu'une victime liste précisément ces deux éditions-là, dans les dix
 *    minutes qui suivent.
 * ⛔ Et c'est pour cela que `MAX_TENTATIVES_JOUR` n'est pas du confort : sans
 *    plafond, on relancerait indéfiniment jusqu'à tomber juste.
 * 🔴 **NE JAMAIS RETIRER `MARGE_MS` NI LE PLAFOND « pour que ça marche mieux ».**
 *    Ce sont les deux seules choses qui séparent ce protocole d'un formulaire
 *    où l'on se déclare propriétaire du portefeuille de quelqu'un d'autre.
 *
 * ── Mesuré en direct le 07/08/2026 ───────────────────────────────────────
 *   · 300 lignes d'escrow = 99 min ⇒ une fenêtre de 10 min tient en 1 page ;
 *   · 0 paire (nom, édition) en double sur 155 dépôts, mais 24 NOMS partagés
 *     ⇒ 🔴 la clé est la PAIRE, jamais le nom ;
 *   · 100 % des noms de collectibles vus dans l'escrow existent dans
 *     `catalogue.csv.gz` — l'autocomplétion du site peut donc aider partout.
 */

/** ⚠️ DEUX, et c'est le minimum. Un seul objet ne prouverait rien : n'importe
 *  qui recopie une ligne du flux public. Deux paires exigent que les deux
 *  viennent du MÊME portefeuille — c'est ça, la preuve. */
export const NB_PAIRES = 2;

/** ⭐ DIX MINUTES — arbitrage de Preda (demandé le 20/07, tranché le 07/08).
 *  L'ancien parcours en laissait trente. La fenêtre n'existe que pour borner
 *  l'exposition au social engineering (« liste ces deux objets et je te les
 *  achète ») : plus elle est courte, moins on est exposé.
 *  ⚠️ Elle ne peut pas descendre beaucoup plus bas : l'indexation de la chaîne
 *  prend 60 s à 2 min (mesuré), et il faut laisser à la personne le temps de
 *  basculer dans l'application VeVe. */
export const FENETRE_MIN = 10;

/** Par COMPTE, et non par portefeuille : il n'y a pas encore de portefeuille. */
export const MAX_TENTATIVES_JOUR = 5;

/** ⚠️ L'horodatage d'un bloc peut précéder de peu la création de la déclaration. */
const MARGE_MS = 2 * 60_000;

export type EtatDecouverte =
  | 'en_attente'
  /** Les deux paires vues, un seul portefeuille : c'est gagné. */
  | 'trouve'
  /** Les deux paires vues, mais DEUX portefeuilles différents. */
  | 'deux_portefeuilles'
  /** Une des paires déclarées est un comic — refusé, et on le DIT. */
  | 'comic'
  | 'expire';

export interface Paire { nom: string; edition: number }
export interface Vue { from: string; at: string; comic: boolean; tokenId: string }

export interface Decouverte {
  id: string; compte_id: string;
  paires: Paire[]; vues: Record<string, Vue>;
  wallet: string | null;
  cree: string; expire: string; etat: EtatDecouverte;
}

/**
 * ⭐⭐ LA CLÉ EST NORMALISÉE, ET C'EST OBLIGATOIRE DES DEUX CÔTÉS.
 * La personne recopie ce qu'elle voit dans son application ; la chaîne rend
 * les métadonnées du jeton. Entre les deux : des apostrophes typographiques
 * (« Hook’s Watch »), des tirets longs, des majuscules, des espaces doubles.
 * ⛔ Comparer les chaînes brutes ferait échouer des objets parfaitement
 *    listés — et la personne le lirait comme SA faute.
 * ⚠️ On ne normalise QUE pour comparer. On affiche toujours le nom d'origine.
 */
export function normNom(s: string): string {
  return String(s ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

// ⭐⭐ TROIS OPÉRATIONS, ET PAS UNE DE PLUS — et c'est le banc qui l'a montré.
// La première version remplaçait aussi les apostrophes typographiques par des
// droites et les tirets longs par des courts. En désarmant ces deux lignes
// pour éprouver le banc, il est resté VERT : `[^a-z0-9]` les efface déjà
// toutes, et `NFKD` détache les accents que le même filtre emporte ensuite.
// ⛔ Ces lignes ne faisaient donc RIEN. Elles avaient l'air d'un soin ; elles
//    étaient une règle sans émetteur — le genre de code qu'un lecteur pressé
//    cite comme preuve que le cas est traité.
// ⚠️ Si un jour ce filtre s'assouplit (garder les espaces, par exemple), il
//    faudra les REMETTRE — et le banc le dira, parce que ses cas
//    « Hook’s Watch » et « Buzz Lightyear – … » sont toujours là.

export const cleDe = (p: { nom: string; edition: number }) => `${normNom(p.nom)}#${p.edition}`;

interface Ligne {
  id: string; compte_id: string; paires: string; vues: string;
  wallet: string | null; cree: string; expire: string; etat: EtatDecouverte;
}

const hydrater = (l: Ligne): Decouverte => ({
  id: l.id, compte_id: l.compte_id,
  paires: JSON.parse(l.paires), vues: JSON.parse(l.vues),
  wallet: l.wallet, cree: l.cree, expire: l.expire, etat: l.etat,
});

export const lireDecouverte = (id: string): Decouverte | undefined => {
  const l = q1<Ligne>('SELECT * FROM decouvertes WHERE id=?', id);
  return l ? hydrater(l) : undefined;
};

/**
 * ⚠️ EN BASE, PAS EN MÉMOIRE — même raison que les défis : sur un téléphone,
 * la personne QUITTE l'onglet pour aller dans l'application VeVe et revient
 * trois minutes plus tard. Entre temps le serveur a pu redémarrer. Une
 * déclaration perdue là, c'est quelqu'un qui a listé deux objets pour rien.
 */
export function decouverteActive(compteId: string): Decouverte | undefined {
  const l = q1<Ligne>(
    "SELECT * FROM decouvertes WHERE compte_id=? AND etat='en_attente' AND expire > ? ORDER BY cree DESC LIMIT 1",
    compteId, now(),
  );
  return l ? hydrater(l) : undefined;
}

export function tentativesDuJour(compteId: string): number {
  const depuis = new Date(Date.now() - 86_400_000).toISOString();
  return q1<{ n: number }>(
    'SELECT COUNT(*) AS n FROM decouvertes WHERE compte_id=? AND cree > ?', compteId, depuis,
  )?.n ?? 0;
}

// ═════════════════════════════════════════════════════════════════════════
// Étape 1 — déclarer, et sceller
// ═════════════════════════════════════════════════════════════════════════

export interface Declaration { decouverte?: Decouverte; erreur?: string; panne?: boolean }

export async function declarer(
  compteId: string,
  paires: { nom: string; edition: unknown }[],
  sante: typeof chaineDisponible = chaineDisponible,
): Promise<Declaration> {
  /**
   * ⭐ ON DEMANDE D'ABORD SI L'EXPLORATEUR VA BIEN — repris de `defi.ts`, et
   * pour la même raison : sans ce contrôle, une panne de CollectScan se
   * présente comme « on ne trouve pas vos objets », c'est-à-dire comme SA
   * faute. Elle refait le geste, échoue encore, et s'en va.
   */
  if (!(await sante())) {
    return {
      panne: true,
      erreur: "L'explorateur de la chaîne (CollectScan) ne répond pas en ce moment. "
        + "Ce n'est pas vous, et vos objets ne sont pas en cause. Réessayez dans quelques minutes.",
    };
  }

  // ⭐ Un seul actif : la déclaration est SCELLÉE, elle ne se remanie pas.
  const active = decouverteActive(compteId);
  if (active) return { decouverte: active };

  if (tentativesDuJour(compteId) >= MAX_TENTATIVES_JOUR)
    return { erreur: `Trop de vérifications tentées aujourd'hui (${MAX_TENTATIVES_JOUR} au maximum). Réessayez demain.` };

  const propres: Paire[] = [];
  for (const p of paires ?? []) {
    const nom = String(p?.nom ?? '').trim();
    const e = Number(p?.edition);
    // ⚠️ `Number('')`, `Number(null)` et `Number([])` valent tous 0 : une
    // édition ABSENTE deviendrait « exemplaire n° 0 », une donnée fausse et
    // non pas une donnée manquante. On exige un entier strictement positif.
    if (!nom || !Number.isInteger(e) || e < 1 || e > 1e9) continue;
    propres.push({ nom, edition: e });
  }
  const uniques = [...new Map(propres.map((p) => [cleDe(p), p])).values()];
  if (uniques.length !== NB_PAIRES)
    return {
      erreur: `Indiquez exactement ${NB_PAIRES} objets DIFFÉRENTS, avec leur nom et leur numéro de mint.`,
    };

  const cree = new Date();
  const d: Decouverte = {
    id: randomUUID(), compte_id: compteId, paires: uniques, vues: {}, wallet: null,
    cree: cree.toISOString(),
    expire: new Date(cree.getTime() + FENETRE_MIN * 60_000).toISOString(),
    etat: 'en_attente',
  };
  run(
    'INSERT INTO decouvertes (id, compte_id, paires, vues, wallet, cree, expire, etat) VALUES (?,?,?,?,?,?,?,?)',
    d.id, d.compte_id, JSON.stringify(d.paires), '{}', null, d.cree, d.expire, d.etat,
  );
  return { decouverte: d };
}

// ═════════════════════════════════════════════════════════════════════════
// Étape 2 — constater le geste dans le flux public
// ═════════════════════════════════════════════════════════════════════════

/**
 * **Idempotent** : la page l'appelle toutes les dix secondes pendant que la
 * personne fait son geste.
 *
 * 🔴 SEULS LES DÉPÔTS POSTÉRIEURS À LA DÉCLARATION COMPTENT. Voir l'en-tête :
 *    c'est la seule chose qui empêche de recopier le flux public de quelqu'un
 *    d'autre.
 */
export async function rafraichir(
  d: Decouverte,
  lireFlux: (depuis: Date) => Promise<FluxEscrow> = (depuis) => fetchEntreesEscrow(depuis),
): Promise<Decouverte> {
  if (d.etat !== 'en_attente') return d;
  if (new Date() > new Date(d.expire)) {
    run("UPDATE decouvertes SET etat='expire' WHERE id=?", d.id);
    return { ...d, etat: 'expire' };
  }

  const depuis = new Date(new Date(d.cree).getTime() - MARGE_MS);
  let flux: FluxEscrow;
  try { flux = await lireFlux(depuis); }
  catch { return d; }                       // la chaîne ne répond pas : on réessaiera

  const attendues = new Map(d.paires.map((p) => [cleDe(p), p]));
  const vues: Record<string, Vue> = { ...d.vues };
  for (const e of flux.entrees) {
    if (!e.name || e.edition == null) continue;
    if (e.at && new Date(e.at) < depuis) continue;    // ceinture et bretelles
    const cle = cleDe({ nom: e.name, edition: e.edition });
    if (!attendues.has(cle)) continue;
    // ⭐ Le PREMIER dépôt gagne : si la personne liste, annule et reliste, les
    // deux lignes portent le même `from` — mais on ne veut pas qu'un second
    // dépôt d'un AUTRE portefeuille vienne écraser le premier.
    if (!vues[cle]) vues[cle] = { from: e.from, at: e.at, comic: e.comic, tokenId: e.tokenId };
  }

  let etat: EtatDecouverte = 'en_attente';
  let wallet: string | null = null;
  const toutes = d.paires.map((p) => vues[cleDe(p)]).filter(Boolean) as Vue[];

  /**
   * 🔴 UN COMIC DÉCLARÉ SE REFUSE EN LE DISANT, IL NE S'IGNORE PAS.
   * L'arbitrage de Preda restreint la preuve aux COLLECTIBLES. Filtrer les
   * comics en silence laisserait la personne devant une case qui ne se coche
   * jamais — exactement la panne que le contrôle de santé existe pour éviter,
   * et cette fois ce serait NOUS qui l'aurions fabriquée.
   * ⚠️ 44 % des mises en vente sont des comics (mesuré) : ce cas est la règle,
   *    pas l'exception.
   */
  if (toutes.some((v) => v.comic)) {
    etat = 'comic';
  } else if (toutes.length === d.paires.length) {
    const froms = new Set(toutes.map((v) => v.from));
    if (froms.size === 1) { etat = 'trouve'; wallet = toutes[0].from; }
    /**
     * 🔴 DEUX PORTEFEUILLES DIFFÉRENTS = REFUS, ET C'EST LE CŒUR DE LA PREUVE.
     * C'est ce qui distingue « je détiens ces deux objets » de « j'ai recopié
     * deux lignes du flux public ». ⛔ Ne jamais retenir « celui qui revient le
     * plus » : il n'y en a que deux, et le mauvais choix donne le portefeuille
     * d'un inconnu à qui l'a copié.
     */
    else etat = 'deux_portefeuilles';
  }

  run('UPDATE decouvertes SET vues=?, wallet=?, etat=? WHERE id=?',
    JSON.stringify(vues), wallet, etat, d.id);
  return { ...d, vues, wallet, etat };
}

// ═════════════════════════════════════════════════════════════════════════
// Étape 3 — ce que la page montre
// ═════════════════════════════════════════════════════════════════════════

export interface Avancement {
  etat: EtatDecouverte;
  faits: number; total: number; restantSec: number;
  wallet: string | null;
  paires: { nom: string; edition: number; vu: boolean }[];
  message: string;
}

const MESSAGES: Record<EtatDecouverte, string> = {
  en_attente: "En attente de vos mises en vente. L'inscription à la chaîne prend une à deux minutes : "
    + "si vous venez de lister, c'est normal que ce ne soit pas encore coché.",
  trouve: 'Portefeuille trouvé et vérifié. Vous pouvez annuler vos deux mises en vente.',
  deux_portefeuilles: "Ces deux objets ont été mis en vente depuis DEUX portefeuilles différents. "
    + "Pour prouver le vôtre, il faut deux objets qui vous appartiennent tous les deux.",
  comic: "Les comics ne conviennent pas pour cette vérification : choisissez deux COLLECTIBLES.",
  expire: 'Le délai est écoulé. Vous pouvez recommencer.',
};

export function avancement(d: Decouverte): Avancement {
  return {
    etat: d.etat,
    faits: d.paires.filter((p) => d.vues[cleDe(p)]).length,
    total: d.paires.length,
    restantSec: Math.max(0, Math.round((new Date(d.expire).getTime() - Date.now()) / 1000)),
    wallet: d.wallet,
    paires: d.paires.map((p) => ({ nom: p.nom, edition: p.edition, vu: Boolean(d.vues[cleDe(p)]) })),
    message: MESSAGES[d.etat],
  };
}

/** Les déclarations vieilles de plus de trois heures n'intéressent plus personne. */
export function purgerDecouvertes(): number {
  const limite = new Date(Date.now() - 3 * 3600_000).toISOString();
  const r = run('DELETE FROM decouvertes WHERE cree < ? AND etat <> ?', limite, 'trouve');
  return Number(r.changes ?? 0);
}
