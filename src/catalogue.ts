import { gunzipSync } from 'node:zlib';

/**
 * ⭐ LE CATALOGUE — POUR AIDER À ÉCRIRE, JAMAIS POUR REFUSER (lot 106).
 *
 * 🔴 CE MODULE N'EST PAS UNE SOURCE DE VÉRITÉ. La vérité est la CHAÎNE :
 *    c'est elle qui dit ce qui a été mis en vente et par qui. Cette liste ne
 *    sert qu'à proposer des noms pendant la saisie.
 *    ⛔ Ne jamais s'en servir pour REFUSER une saisie. Mesuré le 07/08 : le
 *    catalogue PUBLIÉ par veveprice ne couvre que **21 %** des collectibles
 *    réellement mis en vente (il ne publie que les ~1 200 objets cotés) ; le
 *    catalogue COMPLET en couvre **100 %** (75 noms sur 75). Un champ
 *    restreint au premier refuserait quatre objets sur cinq — et la personne
 *    le lirait comme SA faute, exactement la panne que le contrôle de santé
 *    de CollectScan existe déjà pour éviter.
 *
 * ⭐⭐ ET SON ABSENCE NE DOIT RIEN CASSER. Si la Release est injoignable, on
 *    rend une liste vide : le champ reste un champ libre, et le parcours
 *    marche exactement pareil. Une aide qui tombe ne doit pas emporter la
 *    fonction qu'elle aide.
 *
 * ⚠️ 19 407 lignes, dont 2 730 collectibles et 16 677 comics. On ne garde que
 *    les collectibles (arbitrage de Preda) et seulement leur `name` — la
 *    colonne qui correspond aux métadonnées de la chaîne. ⛔ PAS
 *    `name_display` : mesuré, il ne retrouve rien (0 sur 75).
 */
export const CATALOGUE_URL = process.env.CATALOGUE_URL
  || 'https://github.com/fanablefrance/jetonveve/releases/download/catalogue/catalogue.csv.gz';

/** Une journée : ce fichier bouge au rythme des drops, pas des minutes. */
export const TTL_MS = 24 * 3600_000;

/**
 * ⚠️ UN CSV NE SE COUPE PAS SUR LES VIRGULES. La colonne `description` de ce
 * fichier contient des virgules, des guillemets ET DES SAUTS DE LIGNE. Un
 * `split(',')` rendrait des lignes décalées — donc des noms faux, plausibles,
 * et jamais retrouvés sur la chaîne. On lit caractère par caractère.
 */
export function lireCsv(texte: string): string[][] {
  const lignes: string[][] = [];
  let champ = ''; let ligne: string[] = []; let dansGuillemets = false;
  for (let i = 0; i < texte.length; i++) {
    const c = texte[i];
    if (dansGuillemets) {
      if (c === '"') {
        if (texte[i + 1] === '"') { champ += '"'; i++; }   // guillemet échappé
        else dansGuillemets = false;
      } else champ += c;
      continue;
    }
    if (c === '"') { dansGuillemets = true; continue; }
    if (c === ',') { ligne.push(champ); champ = ''; continue; }
    if (c === '\n') { ligne.push(champ); lignes.push(ligne); ligne = []; champ = ''; continue; }
    if (c === '\r') continue;
    champ += c;
  }
  if (champ !== '' || ligne.length) { ligne.push(champ); lignes.push(ligne); }
  return lignes;
}

export function nomsDeCollectibles(csv: string): string[] {
  const lignes = lireCsv(csv);
  if (!lignes.length) return [];
  const entete = lignes[0];
  const iKind = entete.indexOf('kind');
  const iNom = entete.indexOf('name');
  // ⭐ SORTIR SUR UNE DÉCLARATION : si les colonnes attendues ne sont pas là,
  // le fichier a changé de forme. Rendre une liste vide (l'aide disparaît)
  // vaut mieux que rendre 19 407 chaînes prises dans la mauvaise colonne.
  if (iKind < 0 || iNom < 0) {
    console.warn('[catalogue] colonnes « kind » ou « name » absentes : aucune aide à la saisie.');
    return [];
  }
  const vus = new Set<string>();
  for (const l of lignes.slice(1)) {
    if (l[iKind] !== 'Collectible') continue;
    const n = (l[iNom] ?? '').trim();
    if (n) vus.add(n);
  }
  return [...vus].sort((a, b) => a.localeCompare(b, 'fr'));
}

let cache: { a: number; noms: string[] } | null = null;

export async function nomsCollectibles(
  lire: (u: string) => Promise<ArrayBuffer> = async (u) => {
    const r = await fetch(u, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`catalogue ${r.status}`);
    return r.arrayBuffer();
  },
): Promise<string[]> {
  if (cache && Date.now() - cache.a < TTL_MS) return cache.noms;
  try {
    const brut = Buffer.from(await lire(CATALOGUE_URL));
    const texte = (CATALOGUE_URL.endsWith('.gz') ? gunzipSync(brut) : brut).toString('utf8');
    const noms = nomsDeCollectibles(texte);
    // ⚠️ On ne remplace un cache VALIDE par une liste VIDE que si c'est
    //    vraiment ce que dit le fichier — sinon on garderait une aide morte.
    cache = { a: Date.now(), noms };
    console.log(`[catalogue] ${noms.length} collectible(s) pour l'aide à la saisie.`);
    return noms;
  } catch (e) {
    // ⛔ On ne fait PAS échouer la page : l'aide disparaît, la saisie reste.
    console.warn(`[catalogue] injoignable (${(e as Error).message}) : saisie libre, sans suggestions.`);
    return cache?.noms ?? [];
  }
}

/** Réservé aux tests. */
export const oublierCatalogue = () => { cache = null; };
