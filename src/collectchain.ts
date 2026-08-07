/**
 * Client CollectChain (explorateur Blockscout public, sans authentification).
 * Deux usages : lire les avoirs d'un wallet, et détecter les dépôts en escrow.
 * ⚠️ Le contrat VeVe est en ERC-721 (le filtre ERC-1155 renvoie vide, silencieusement).
 */
export const BASE = 'https://collectscan.com/api/v2';
export const VEVE_CONTRACT = '0xbcFEbA7A9dA14f5C9453bDA72E2098537867B3c7'.toLowerCase();
export const ESCROW = '0xb1af72a77b9065c55cda0680b86655a79b62e42c';

export interface Holding {
  tokenId: string; name: string; edition: number | null; totalEditions: number | null;
  rarity: string | null; series: string | null; image: string | null;
}
export interface EscrowDeposit { tokenId: string; name: string; edition: number | null; at: string; block: number; }

const lc = (s: unknown) => String(s ?? '').toLowerCase();

/**
 * 🔴 Une édition doit être un ENTIER POSITIF, pas « ce que Number() en fait ».
 * `Number('12/500')` vaut NaN, qui n'est ni `null` ni un nombre utilisable :
 * il traversait le filtre, arrivait jusqu'à SQLite et faisait ÉCHOUER
 * l'insertion — au milieu de la synchronisation. Un seul objet malformé
 * condamnait donc le portefeuille entier, à chaque tour, définitivement.
 */
const editionValide = (v: unknown): number | null => {
  // ⚠️ Ne PAS se contenter de `Number(v)` : `Number('')`, `Number(' ')`,
  // `Number(null)` et `Number([])` valent tous 0. Une édition ABSENTE
  // deviendrait alors « exemplaire n° 0 » — une donnée fausse, et non pas
  // une donnée manquante. On exige une forme numérique explicite.
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 && v < 1e9 ? v : null;
  if (typeof v === 'string' && /^\s*\d{1,9}\s*$/.test(v)) return Number(v.trim());
  return null;
};

/**
 * 🔴 LES COMICS NE SONT PAS DES COMBATTANTS — décision du 18/07, restée
 * NON CODÉE jusqu'au 19/07 au soir. Relevé par Preda : il détient
 * **1 409 comics pour 314 collectibles**, et les comics entraient tous
 * dans le jeu.
 *
 * Ce n'était pas qu'une question de propreté : à 1 723 objets, la page de
 * collection pesait 4,4 Mo et la resynchronisation figeait le serveur
 * mono-fil ~14 secondes. Le filtre est donc AUSSI le correctif d'échelle.
 *
 * ⭐ DEUX MARQUEURS INDÉPENDANTS, relevés dans les données réelles du
 * portefeuille de Preda plutôt que devinés :
 *   · un comic porte `metadata.comicNumber` (« 10 », « 24 »…) ;
 *   · et son image est un `comic_cover`, là où un collectible est un
 *     `collectible_type_image`.
 * On exige les DEUX absences. Un seul critère qui changerait chez VeVe
 * laisserait passer 1 400 objets sans que personne s'en aperçoive.
 */
export function estUnComic(m: any, image?: string | null): boolean {
  if (m?.comicNumber != null && String(m.comicNumber).trim() !== '') return true;
  return /comic[_-]?cover/i.test(String(image ?? m?.image ?? ''));
}

export function parseHoldings(payload: any): Holding[] {
  const out: Holding[] = [];
  for (const it of payload?.items ?? []) {
    if (lc(it?.token?.address_hash) !== VEVE_CONTRACT) continue;
    const m = it?.metadata ?? {};
    if (m.edition == null || !m.name) continue;   // métadonnées parfois absentes
    if (estUnComic(m, it.image_url)) continue;    // un comic n'est pas un combattant
    const edition = editionValide(m.edition);
    if (edition === null) continue;               // édition illisible : on passe, on ne casse pas
    out.push({
      tokenId: String(it.id), name: String(m.name), edition,
      totalEditions: m.totalEditions != null ? editionValide(m.totalEditions) : null,
      rarity: m.rarity ?? null, series: m.series ?? null,
      // ⚠️ `it.image_url` est TOUJOURS null dans les vraies réponses : la
      // véritable adresse d'image vit dans `metadata.image`.
      image: m.image ?? it.image_url ?? null,
    });
  }
  return out;
}

export function parseEscrowDeposits(payload: any, since?: Date): EscrowDeposit[] {
  const out: EscrowDeposit[] = [];
  for (const it of payload?.items ?? []) {
    if (lc(it?.to?.hash) !== ESCROW) continue;             // seulement les mises en vente
    const ti = it?.total?.token_instance ?? {};
    const m = ti?.metadata ?? {};
    const at = String(it.timestamp ?? '');
    if (since && at && new Date(at) < since) continue;
    out.push({
      tokenId: String(it?.total?.token_id ?? ti?.id ?? ''),
      name: m.name ? String(m.name) : '(inconnu)',
      edition: m.edition != null ? editionValide(m.edition) : null,
      at, block: Number(it.block_number ?? 0),
    });
  }
  return out;
}

async function get(url: string, timeoutMs = 12000): Promise<any> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`CollectScan ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

/**
 * 🔴 UNE VUE PARTIELLE DOIT SE SAVOIR PARTIELLE.
 *
 * La pagination s'arrêtait à 3 pages « parce qu'on n'a pas besoin de tout
 * pour un défi » — sauf que la MÊME fonction sert à la resynchronisation,
 * qui GÈLE tout mint absent de la liste. Un collectionneur de 200 pièces
 * voyait donc 50 combattants gelés à tort à chaque tour, et les whales
 * VeVe en détiennent des milliers.
 *
 * On remonte la borne, et surtout on dit si la vue est COMPLÈTE. Geler est
 * destructeur, lire ne l'est pas : sans certitude, on ne gèle pas.
 */
export interface Avoirs { liste: Holding[]; complet: boolean }

export async function fetchAvoirs(wallet: string, maxPages = 40): Promise<Avoirs> {
  let url = `${BASE}/addresses/${wallet}/nft?type=ERC-721`;
  const liste: Holding[] = [];
  for (let p = 0; p < maxPages; p++) {
    const j = await get(url);
    liste.push(...parseHoldings(j));
    const n = j?.next_page_params;
    if (!n) return { liste, complet: true };
    url = `${BASE}/addresses/${wallet}/nft?type=ERC-721&` + new URLSearchParams(n as any).toString();
  }
  // Encore des pages après la borne : on a vu une partie, pas le tout.
  console.warn(`[chaîne] ${wallet.slice(0, 10)}… dépasse ${maxPages} pages : vue partielle, aucun gel.`);
  return { liste, complet: false };
}

/** Vue simple, pour le défi de propriété : une vue partielle y suffit. */
export const fetchHoldings = async (wallet: string, maxPages = 3): Promise<Holding[]> =>
  (await fetchAvoirs(wallet, maxPages)).liste;

/** Dépôts en escrow depuis le wallet — le signal de la mise en vente. */
export async function fetchEscrowDeposits(wallet: string, since?: Date): Promise<EscrowDeposit[]> {
  const j = await get(`${BASE}/addresses/${wallet}/token-transfers?filter=from`);
  return parseEscrowDeposits(j, since);
}

export const isWallet = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s.trim());

/**
 * ⭐ EST-CE QUE L'EXPLORATEUR VA BIEN ?
 *
 * ⚠️ Sans ce contrôle, une panne de CollectScan se présente au joueur
 *    comme « aucun collectible trouvé » — c'est-à-dire comme SA faute,
 *    alors que rien chez lui n'est en cause. Il refait le geste, il
 *    échoue encore, et il s'en va. Une panne d'un service tiers est un
 *    état PRÉVISIBLE : elle mérite sa propre phrase.
 *
 * On interroge la route la moins chère de l'API — les statistiques —
 * avec un délai court : on veut savoir si le service RÉPOND, pas
 * attendre qu'il finisse de réfléchir.
 *
 * ⚠️ Le résultat est gardé quelques secondes. Sur la page de
 *    vérification, chaque joueur sonde toutes les dix secondes ; sans
 *    cache, on ajouterait notre propre charge à un service déjà en peine.
 */
let _sante: { a: number; ok: boolean } | null = null;
export const SANTE_TTL_MS = 15_000;

export async function chaineDisponible(timeoutMs = 5000): Promise<boolean> {
  if (_sante && Date.now() - _sante.a < SANTE_TTL_MS) return _sante.ok;
  let ok = false;
  try {
    await get(`${BASE}/stats`, timeoutMs);
    ok = true;
  } catch { ok = false; }
  _sante = { a: Date.now(), ok };
  return ok;
}

/** Réservé aux tests : oublie le dernier état connu. */
export const oublierSante = () => { _sante = null; };

/**
 * ⚠️ DÉFAUT CORRIGÉ : mettre un collectible EN VENTE le fait sortir du
 * portefeuille (il part en escrow). Il disparaît donc des avoirs — et une
 * synchronisation naïve le prendrait pour une revente, gelant le combattant.
 * Pire : notre propre défi de propriété DEMANDE de mettre en vente.
 *
 * On reconstitue donc l'état réel en parcourant les transferts dans les deux
 * sens : si le dernier mouvement d'un jeton est portefeuille -> escrow,
 * il est EN VENTE, pas vendu.
 */
export interface EnVente { tokenId: string; name: string; edition: number | null; depuis: string }

export function parseEnVente(payload: any, wallet: string): Map<string, EnVente> {
  const w = wallet.toLowerCase();
  const dernier = new Map<string, { sens: 'sortie' | 'entree'; at: string; ev: EnVente }>();
  const items = [...(payload?.items ?? [])].sort(
    (a, b) => String(a.timestamp ?? '').localeCompare(String(b.timestamp ?? '')));
  for (const it of items) {
    if (lc(it?.token?.address_hash) !== VEVE_CONTRACT) continue;
    const from = lc(it?.from?.hash); const to = lc(it?.to?.hash);
    const ti = it?.total?.token_instance ?? {}; const md = ti?.metadata ?? {};
    const id = String(it?.total?.token_id ?? ti?.id ?? '');
    if (!id) continue;
    const ev: EnVente = {
      tokenId: id, name: md.name ? String(md.name) : '(inconnu)',
      edition: md.edition != null ? editionValide(md.edition) : null, depuis: String(it.timestamp ?? ''),
    };
    if (from === w && to === ESCROW) dernier.set(id, { sens: 'sortie', at: ev.depuis, ev });
    else if (to === w) dernier.delete(id);          // revenu (annulation) ou reçu
    else if (from === w) dernier.delete(id);        // parti ailleurs : vraie sortie
  }
  const out = new Map<string, EnVente>();
  for (const [id, d] of dernier) if (d.sens === 'sortie') out.set(id, d.ev);
  return out;
}

/** Jetons actuellement déposés en escrow par ce portefeuille = mis en vente. */
export async function fetchEnVente(wallet: string): Promise<Map<string, EnVente>> {
  const j = await get(`${BASE}/addresses/${wallet}/token-transfers`);
  return parseEnVente(j, wallet);
}


// ═════════════════════════════════════════════════════════════════════════
// 🔥 LOT 106 — LIRE L'ESCROW, ET NON PLUS UN PORTEFEUILLE
// ═════════════════════════════════════════════════════════════════════════
//
// 🔴 LE PROBLÈME QUE ÇA FERME. Tout ce qui précède part d'une adresse `0x…`
// **que la personne doit taper**. Or elle ne la connaît pas : VeVe ne la lui
// montre nulle part. Elle connaît son pseudo et le n° de mint de ses objets.
// Le champ d'inscription lui demandait donc la seule chose qu'elle n'a pas —
// et bloquait tout le reste.
//
// ⭐⭐⭐ LA TROUVAILLE : ON N'A PAS BESOIN DE TROUVER LE PORTEFEUILLE.
// L'escrow VeVe est une adresse PUBLIQUE et UNIQUE : toute mise en vente y
// dépose le jeton, et chaque ligne porte `from` — le portefeuille du vendeur.
// La personne nomme deux de ses objets, les liste, on les retrouve dans le
// flux, et **les deux `from` doivent être identiques**. Cette adresse EST son
// portefeuille : découvert et prouvé du même geste.
// ⭐ C'est plus SÛR que l'ancien parcours, pas seulement plus commode :
// l'adresse ne se déclare plus, elle SORT de la preuve.
//
// ── Mesuré en direct le 07/08/2026, sans cookie et sans clé ──────────────
//   · 300 lignes en 6 pages couvrent 99 minutes  ⇒ une fenêtre de 10 min
//     tient largement dans UNE page de 50.
//   · sur ces 300 lignes : 155 dépôts (mises en vente) et 145 sorties.
//   · 0 paire (nom, édition) en double — mais 24 NOMS portés par plusieurs
//     dépôts. 🔴 **La clé est la paire, jamais le nom.**
//   · 44 % des dépôts sont des comics.
//
// ⚠️ `?type=ERC-721` est OBLIGATOIRE ici comme ailleurs : le filtre ERC-1155
//    renvoie vide, en silence.
export interface EntreeEscrow {
  tokenId: string;
  name: string;
  edition: number | null;
  /** 🔴 LE PORTEFEUILLE DU VENDEUR — la seule raison d'être de cette lecture. */
  from: string;
  at: string;
  block: number;
  /** Un comic déclaré doit être REFUSÉ EN LE DISANT, pas ignoré (cf. decouverte.ts). */
  comic: boolean;
}

export function parseEntreesEscrow(payload: any, depuis?: Date): EntreeEscrow[] {
  const out: EntreeEscrow[] = [];
  for (const it of payload?.items ?? []) {
    // ⛔ Seulement ce qui ENTRE dans l'escrow : une sortie est une annulation
    // ou une vente, et ne prouve la propriété de personne.
    if (lc(it?.to?.hash) !== ESCROW) continue;
    if (lc(it?.token?.address_hash) !== VEVE_CONTRACT) continue;
    const ti = it?.total?.token_instance ?? {};
    const m = ti?.metadata ?? {};
    const at = String(it.timestamp ?? '');
    if (depuis && at && new Date(at) < depuis) continue;
    const from = lc(it?.from?.hash);
    if (!from) continue;
    out.push({
      tokenId: String(it?.total?.token_id ?? ti?.id ?? ''),
      name: m.name ? String(m.name) : '',
      edition: m.edition != null ? editionValide(m.edition) : null,
      from, at, block: Number(it.block_number ?? 0),
      comic: estUnComic(m, m?.image ?? it?.image_url),
    });
  }
  return out;
}

/**
 * ⭐⭐ UNE VUE PARTIELLE DOIT SE SAVOIR PARTIELLE — la même règle que
 * `fetchAvoirs`, et elle compte davantage ici : si on s'arrête AVANT d'avoir
 * remonté jusqu'à `depuis`, un dépôt réel peut être resté de l'autre côté de
 * la borne. Le déclarer « pas encore vu » serait faux ; on dit `complet:false`
 * et l'appelant s'abstient de conclure à l'échec.
 *
 * ⚠️ On remonte tant que la dernière ligne lue est POSTÉRIEURE à `depuis` :
 * c'est le flux qui décide du nombre de pages, pas un nombre écrit en dur.
 * Mesuré : 10 minutes ≈ 1 page. `maxPages` n'est qu'un garde-fou de boucle.
 */
export interface FluxEscrow { entrees: EntreeEscrow[]; complet: boolean }

export async function fetchEntreesEscrow(
  depuis: Date, maxPages = 8, lire: (u: string) => Promise<any> = get,
): Promise<FluxEscrow> {
  let url = `${BASE}/addresses/${ESCROW}/token-transfers?type=ERC-721`;
  const entrees: EntreeEscrow[] = [];
  for (let p = 0; p < maxPages; p++) {
    const j = await lire(url);
    entrees.push(...parseEntreesEscrow(j, depuis));
    const brut = j?.items ?? [];
    // Plus rien d'antérieur à lire : la dernière ligne de la page a déjà
    // franchi la borne, donc tout ce qui suit est plus vieux encore.
    const derniere = brut.length ? String(brut[brut.length - 1]?.timestamp ?? '') : '';
    if (derniere && new Date(derniere) < depuis) return { entrees, complet: true };
    const n = j?.next_page_params;
    if (!n) return { entrees, complet: true };
    url = `${BASE}/addresses/${ESCROW}/token-transfers?type=ERC-721&`
      + new URLSearchParams(n as any).toString();
  }
  console.warn(`[escrow] ${maxPages} pages lues sans atteindre ${depuis.toISOString()} : vue partielle.`);
  return { entrees, complet: false };
}
