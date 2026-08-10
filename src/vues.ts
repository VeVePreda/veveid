import type { Avancement, Eligibles } from './defi.ts';
import type { Avancement as AvancementDecouverte } from './decouverte.ts';
import { NB_PAIRES, FENETRE_MIN as FENETRE_DECOUVERTE } from './decouverte.ts';
import { PRIX_MIN, PRIX_MAX, NB_CIBLES, FENETRE_MIN } from './defi.ts';
import type { Avoir, Compte } from './avoirs.ts';
import { CHAMP_PIEGE, sceau } from './robots.ts';
import { DELAI_GRACE_JOURS } from './avoirs.ts';
import type { Forme, LigneSite, Activite, Trouvaille } from './admin.ts';

/**
 * LES VUES DU SERVICE D'IDENTITÉ — téléphone d'abord, comme les jeux.
 *
 * ⚠️ Ce service est une PORTE, pas une destination. Le joueur n'y vient
 *    que pour prouver qu'il détient sa collection, puis il repart jouer.
 *    Chaque écran doit donc dire où l'on va et pourquoi — et ne jamais
 *    retenir personne.
 */

export const echapper = (s: unknown) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const enJson = (o: unknown) => JSON.stringify(o).replace(/</g, '\\u003c');

const CSS = `
:root{--fond:#14161b;--carte:#1c1f26;--trait:#2b303a;--texte:#e6e3dc;--doux:#9aa0ab;
  --or:#c9a227;--sang:#a8443a;--vert:#5e8c5a}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--fond);color:var(--texte);
  font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--or)} main{max-width:560px;margin:0 auto;padding:14px 14px 48px}
h1{font-size:1.3rem;margin:0} h2{font-size:.95rem;margin:22px 0 8px;color:var(--doux);
  font-weight:600;text-transform:uppercase;letter-spacing:.06em}
.doux{color:var(--doux);font-size:.9rem}
.bandeau{display:flex;justify-content:space-between;align-items:center;gap:10px;
  padding:10px 0 12px;border-bottom:1px solid var(--trait);margin-bottom:6px}
.carte{background:var(--carte);border:1px solid var(--trait);border-radius:12px;padding:14px;margin:10px 0}
.rang{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
input,select,button{font:inherit;font-size:16px;background:#22262e;color:var(--texte);
  border:1px solid var(--trait);border-radius:10px;padding:12px 13px;min-height:46px;width:100%}
button{cursor:pointer;background:#2c313b;font-weight:600}
button.principal{background:var(--or);color:#1a1408;border-color:var(--or)}
button.danger{background:#3a2a28;border-color:var(--sang);color:#e8bfb9}
button[disabled]{opacity:.45}
.err{background:#3a2523;border:1px solid var(--sang);border-radius:10px;padding:12px;margin:10px 0;font-size:.92rem}
.ok{background:#25331f;border:1px solid var(--vert);border-radius:10px;padding:12px;margin:10px 0;font-size:.92rem}
.jauge{height:10px;background:#2b303a;border-radius:6px;overflow:hidden;flex:1;min-width:80px}
.jauge>i{display:block;height:100%;background:var(--vert);transition:width .25s}
.ligne{display:flex;gap:12px;align-items:center;padding:11px 4px;border-bottom:1px solid var(--trait)}
.ligne:last-child{border-bottom:0}
label.choix{display:flex;gap:12px;align-items:center;padding:12px 4px;border-bottom:1px solid var(--trait);cursor:pointer}
.coche{width:26px;height:26px;border-radius:50%;border:2px solid var(--trait);flex:none;
  display:flex;align-items:center;justify-content:center;font-size:.8rem}
.coche.vu{background:var(--vert);border-color:var(--vert);color:#0f150e}
/* ⛔ PAS display:none, PAS type=hidden : un robot un peu serieux ignore les
   deux. On sort le champ de l'ecran, il reste « visible » pour le code. */
.piege{position:absolute!important;left:-9999px!important;top:auto!important;
  width:1px!important;height:1px!important;overflow:hidden}
`;

export const page = (titre: string, corps: string, script = '') =>
  `<!doctype html><html lang="fr"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#14161b"><meta name="color-scheme" content="dark">
<meta name="robots" content="noindex">
<title>${echapper(titre)} — Identité</title><style>${CSS}</style><main>${corps}</main>${script}`;

const entete = (titre: string, droite = '') =>
  `<div class="bandeau"><h1>${echapper(titre)}</h1><div class="doux">${echapper(droite)}</div></div>`;

const prix = (n: number) => n.toLocaleString('fr-FR');

export function accueil(jeu?: string, erreur?: string): string {
  const marque = sceau();
  return page('Identité', `${entete('Identité')}
  ${erreur ? `<div class="err">${echapper(erreur)}</div>` : ''}
  <div class="carte">
    <p style="margin-top:0">${jeu
      ? `<b>${echapper(jeu)}</b> a besoin de savoir que la collection est bien la vôtre.`
      : 'Un seul compte pour tous les jeux.'}</p>
    <p class="doux">Vous prouvez que vous détenez vos collectibles <b>une seule fois</b>.
    Tous les jeux, présents et à venir, s’appuient dessus.</p>
  </div>
  <form method="post" action="/inscription">
    <div class="carte">
      <label for="email"><b>Votre adresse e-mail</b></label>
      <p class="doux" style="margin:4px 0 10px">Nous vous envoyons un lien. Pas de mot de passe
      à choisir, donc pas de mot de passe à perdre.</p>
      <input id="email" name="email" type="email" placeholder="vous@exemple.fr" inputmode="email"
        autocapitalize="off" autocomplete="email" spellcheck="false" required>

      ${/* ⭐ LE CHAMP PIÈGE. Invisible à l'écran, rempli par les robots qui
             remplissent « tous les champs ». ⚠️ aria-hidden + tabindex=-1
             + autocomplete=off sont OBLIGATOIRES : sans eux, un lecteur
             d'écran l'annonce et un gestionnaire de mots de passe le remplit
             — on bloquerait de vraies personnes, en silence. */''}
      <div class="piege" aria-hidden="true">
        <label for="${CHAMP_PIEGE}">Ne remplissez pas ce champ</label>
        <input id="${CHAMP_PIEGE}" name="${CHAMP_PIEGE}" type="text"
          tabindex="-1" autocomplete="off">
      </div>
      ${/* ⭐ L'heure d'affichage, SIGNÉE : un formulaire revenu en moins de
             deux secondes et demie n'a pas été rempli par un humain. */''}
      <input type="hidden" name="sceau" value="${echapper(marque)}">

      <p style="margin:12px 0 0"><button class="principal">Recevoir mon lien</button></p>
    </div>
  </form>

  <h2>Vous avez un portefeuille VeVe ?</h2>
  <form method="post" action="/entrer">
    <div class="carte">
      <p class="doux" style="margin-top:0">Vous pouvez aussi entrer directement par votre adresse
      de portefeuille. Vous prouverez ensuite qu’elle est bien la vôtre.</p>
      <input name="wallet" placeholder="0x…" inputmode="text" autocapitalize="off"
        autocomplete="off" spellcheck="false" required>
      <p style="margin:12px 0 0"><button>Continuer avec mon portefeuille</button></p>
    </div>
  </form>
  <p class="doux">Nous ne demandons jamais vos identifiants VeVe, et il n’y a rien à signer :
  votre adresse est publique, elle ne prouve rien à elle seule.</p>`);
}

/**
 * ⭐ « Regardez vos e-mails » — et RIEN D'AUTRE.
 *
 * 🔴 CETTE PAGE EST LA MÊME QUE L'ADRESSE EXISTE OU NON, que le compte
 *    soit neuf ou ancien, et même si l'envoi a échoué. Une page qui
 *    dirait « compte créé » d'un côté et « content de vous revoir » de
 *    l'autre transformerait le formulaire en outil pour savoir qui est
 *    inscrit — sur un site public, avec une liste d'adresses achetée,
 *    c'est une fuite à l'échelle.
 *
 * ⚠️ On n'affiche même pas l'adresse saisie : elle serait dans l'URL ou
 *    dans le HTML, donc dans l'historique et le journal du proxy.
 */
export function pageLienEnvoye(minutes: number): string {
  return page('Vérifiez vos e-mails', `${entete('Vérifiez vos e-mails')}
  <div class="ok"><b>C’est parti.</b> Si cette adresse peut recevoir du courrier, un lien de
  connexion vient d’y être envoyé.</div>
  <div class="carte">
    <p style="margin-top:0">Ouvrez le message et cliquez sur le lien. Il est valable
    <b>${minutes} minutes</b> et ne fonctionne qu’une seule fois.</p>
    <p class="doux" style="margin-bottom:0">Rien n’arrive ? Regardez dans les indésirables, puis
    <a href="/">réessayez</a> — vérifiez au passage qu’il n’y a pas de faute de frappe.</p>
  </div>
  <p class="doux">Vous pouvez fermer cette page : le lien fonctionne depuis n’importe quel
  appareil, sur ce même navigateur ou un autre.</p>`);
}

export function pageChoisir(e: Eligibles, erreur?: string): string {
  const items = (e.liste ?? []).map((h) => `<label class="choix">
    <input type="checkbox" name="t" value="${echapper(h.tokenId)}" style="width:24px;min-height:24px;flex:none">
    <span style="flex:1"><b>${echapper(h.name)}</b>${h.edition != null ? ` <span class="doux">#${h.edition}</span>` : ''}
    ${h.rarity ? `<br><span class="doux">${echapper(h.rarity)}</span>` : ''}</span>
  </label>`).join('');
  const ecartes = (e.ecartes ?? []).length ? `<div class="carte">
    <b>Déjà en vente — écartés</b>
    <p class="doux" style="margin:6px 0 0">Un objet déjà déposé en escrow ne produira aucun
    nouveau dépôt : vous attendriez devant une case qui ne se coche jamais.</p>
    <p class="doux">${(e.ecartes ?? []).map((h) => echapper(h.name) + (h.edition != null ? ` #${h.edition}` : '')).join(' · ')}</p>
  </div>` : '';
  return page('Choisir', `${entete('Vérification', '1 / 2')}
  ${erreur ? `<div class="err">${echapper(erreur)}</div>` : ''}
  <div class="carte">
    <p style="margin-top:0">Un portefeuille VeVe est <b>sous garde</b> : vous n’avez pas vos clés,
    vous ne pouvez donc rien signer. On vérifie autrement — par une action que
    <b>seul le vrai détenteur peut faire</b>.</p>
    <p><b>Choisissez ${NB_CIBLES} collectibles</b> que vous accepterez de mettre en vente,
    puis d’annuler. C’est gratuit.</p>
  </div>
  <form method="post" action="/choisir">
    <div class="carte">${items || '<p class="doux">Aucun collectible disponible.</p>'}</div>
    <button class="principal" ${e.liste && e.liste.length >= NB_CIBLES ? '' : 'disabled'}>Continuer</button>
  </form>
  ${ecartes}`);
}

export function pageDefi(a: Avancement, defiId: string, erreur?: string): string {
  const cibles = a.cibles.map((c) => `<div class="ligne">
    <span class="coche ${c.vu ? 'vu' : ''}">${c.vu ? '✓' : ''}</span>
    <span><b>${echapper(c.nom)}</b>${c.edition != null ? ` <span class="doux">#${c.edition}</span>` : ''}</span>
  </div>`).join('');
  return page('Vérification', `${entete('Vérification', '2 / 2')}
  ${erreur ? `<div class="err">${echapper(erreur)}</div>` : ''}
  <div class="carte">
    <p style="margin-top:0"><b>Mettez ces ${a.total} objets en vente dans l’application VeVe</b>,
    puis annulez.</p>
    <div class="err" style="background:#332b1e;border-color:var(--or)">
      🔴 <b>Prix obligatoire : entre ${prix(PRIX_MIN)} et ${prix(PRIX_MAX)}.</b>
      <p style="margin:6px 0 0">À un prix normal, quelqu’un peut les <b>acheter pour de bon</b>
      pendant la vérification — et vous auriez perdu votre collectible par notre faute.
      Personne n’achète à ${prix(PRIX_MIN)}.</p>
      <p class="doux" style="margin:6px 0 0">Nous ne pouvons pas lire le prix d’une offre en
      cours : la chaîne ne le publie pas. Ce contrôle-là ne tient qu’à vous.</p>
    </div>
    ${cibles}
    <p class="doux" style="margin:10px 0 0">Vous avez ${FENETRE_MIN} minutes. Cette limite
    empêche qu’on vous fasse lister des objets sous un prétexte et qu’on s’en serve plus tard.</p>
  </div>
  <div class="carte">
    <div class="rang"><b id="compte">${a.faits}/${a.total}</b>
      <span class="jauge"><i id="barre" style="width:${(a.faits / a.total) * 100}%"></i></span></div>
    <p class="doux" style="margin:10px 0 0">Il reste <b id="reste">${Math.ceil(a.restantSec / 60)}</b> minutes.
    On regarde la chaîne toutes les dix secondes ; comptez une à deux minutes après votre geste.</p>
  </div>`, `<script>
const id=${enJson(defiId)};
async function sonder(){
  try{
    const r=await fetch('/defi.json?id='+encodeURIComponent(id),{headers:{accept:'application/json'}});
    const a=await r.json();
    document.getElementById('compte').textContent=a.faits+'/'+a.total;
    document.getElementById('barre').style.width=(a.faits/a.total*100)+'%';
    document.getElementById('reste').textContent=Math.ceil(a.restantSec/60);
    document.querySelectorAll('.coche').forEach((el,i)=>{
      if(a.cibles[i]&&a.cibles[i].vu){el.classList.add('vu');el.textContent='✓';}
    });
    if(a.etat==='verifie'){location.href='/apres';return;}
    if(a.etat==='expire'){location.href='/?msg=expire';return;}
  }catch(e){}
  setTimeout(sonder,10000);
}
setTimeout(sonder,10000);
</script>`);
}

export function pageCompte(
  c: Compte, avoirs: Avoir[], abonne: boolean, sync: { dernier: string; resultat: string; complet: number } | undefined,
  jeu: string | null, message?: string,
): string {
  const liste = avoirs.slice(0, 60).map((a) => `<div class="ligne">
    <span style="flex:1"><b>${echapper(a.nom)}</b> <span class="doux">#${a.edition}</span></span>
    <span class="doux">${echapper(a.rarete ?? '')}</span>
  </div>`).join('') || '<p class="doux">Aucun collectible lu pour l’instant.</p>';

  /**
   * ⚠️ `c.wallet` PEUT ÊTRE NULL depuis le lot 89. L'ancien
   *    `c.wallet.slice(0, 8)` faisait tomber la page entière — pas un
   *    affichage vide : une exception, donc un 500, sur la page d'accueil
   *    de tout membre inscrit par e-mail.
   */
  const coin = c.wallet ? c.wallet.slice(0, 8) + '…' : (c.email ?? '');
  return page('Mon compte', `${entete('Mon compte', coin)}
  ${message ? `<div class="ok">${echapper(message)}</div>` : ''}
  ${c.supprime_le ? `<div class="err">
    <b>Suppression demandée.</b> Tout sera effacé ${DELAI_GRACE_JOURS} jours après le
    ${echapper(c.supprime_le.slice(0, 10))}.
    <form method="post" action="/annuler-suppression" style="margin-top:10px">
      <button>Annuler la suppression</button></form>
  </div>` : ''}

  ${jeu ? `<div class="ok"><b>${echapper(jeu)}</b> vous attend.
    <p style="margin:8px 0 0"><a href="/apres">Retourner au jeu →</a></p></div>` : ''}

  ${c.email ? `<div class="carte">
    <div class="rang"><b style="flex:1">Adresse e-mail</b></div>
    <p class="doux" style="margin:8px 0 0">${echapper(c.email)}</p>
  </div>` : ''}

  ${c.wallet ? `<div class="carte">
    <div class="rang"><b style="flex:1">Portefeuille</b>
      <span class="doux">${c.verifie ? '✅ vérifié' : 'non vérifié'}</span></div>
    <p class="doux" style="margin:8px 0 0">${echapper(c.wallet)}</p>
  </div>` : `<div class="carte">
    <div class="rang"><b style="flex:1">Portefeuille VeVe</b>
      <span class="doux">facultatif</span></div>
    <p class="doux" style="margin:8px 0 12px">Vérifiez le vôtre pour retrouver vos collectibles
    ici, recevoir des alertes sur <b>vos</b> pièces et apparaître au classement.
    Votre compte fonctionne très bien sans.</p>
    <p style="margin:12px 0 0"><a class="bouton" href="/decouvrir">Vérifier mon portefeuille VeVe</a></p>
    <details style="margin-top:14px">
      <summary class="doux">Je connais mon adresse 0x…</summary>
      <form method="post" action="/lier-portefeuille" style="margin-top:10px">
        <input name="wallet" placeholder="0x…" inputmode="text" autocapitalize="off"
          autocomplete="off" spellcheck="false" required>
        <p style="margin:12px 0 0"><button>Continuer avec cette adresse</button></p>
      </form>
    </details>
  </div>`}

  <div class="carte">
    <div class="rang"><b style="flex:1">Abonnement</b>
      <span class="doux">${abonne ? `jusqu’au ${echapper(c.abonne_jusqu_a!.slice(0, 10))}` : 'aucun'}</span></div>
    <p class="doux" style="margin:8px 0 0">${abonne
      ? 'Notifications poussées, et jusqu’à trois héros par jeu — qui partagent le même stock.'
      : 'Sans abonnement, vous recevez les notifications simples et jouez un héros par jeu.'}</p>
  </div>

  ${!c.wallet ? '' : `
  <h2>Mes collectibles</h2>
  <form method="post" action="/synchroniser"><div class="carte">
    <p class="doux" style="margin-top:0">${avoirs.length} collectible(s).
    ${sync ? `Dernière lecture : ${echapper(sync.dernier.slice(0, 16).replace('T', ' à '))}.` : ''}
    ${sync && !sync.complet ? '<br>⚠️ Vue partielle la dernière fois — rien n’a été retiré.' : ''}</p>
    <button>Relire la chaîne</button>
  </div></form>
  <div class="carte">${liste}
    ${avoirs.length > 60 ? `<p class="doux">…et ${avoirs.length - 60} autres.</p>` : ''}</div>`}

  <h2>Quitter</h2>
  <div class="carte">
    <p class="doux" style="margin-top:0">Effacer votre compte efface votre identité, vos
    avoirs et vos cartes dans les jeux. <b>Vos héros et leurs codex, non</b> : ils
    appartiennent aux collectibles et repartiront avec eux si vous les revendez.</p>
    ${!c.supprime_le ? `<form method="post" action="/supprimer">
      <button class="danger">Demander la suppression de mon compte</button>
      <p class="doux" style="margin:6px 0 0">Vous aurez ${DELAI_GRACE_JOURS} jours pour revenir
      sur votre décision.</p></form>` : ''}
  </div>
  <p class="doux"><a href="/deconnexion">Se déconnecter</a></p>`);
}


// ═════════════════════════════════════════════════════════════════════════
// 🔥 LOT 106 — LES DEUX ÉCRANS DE LA DÉCOUVERTE SANS ADRESSE
// ═════════════════════════════════════════════════════════════════════════
//
// ⭐⭐ CE QUE CES DEUX ÉCRANS NE DEMANDENT PAS : l'adresse du portefeuille.
// C'est tout l'objet du lot. La personne connaît son pseudo VeVe et le n° de
// mint de ses objets ; elle ne connaît pas son adresse, VeVe ne la lui montre
// nulle part. On lui demande ce qu'elle a.
// 🔴 LA CONSIGNE DE PRIX RESTE, ET C'EST LA SEULE PROTECTION RÉELLE.
// Preda a demandé le 20/07 de ne plus AVOUER qu'on ne peut pas vérifier le
// prix — c'est fait, la phrase a disparu. ⛔ Mais l'AVEU et la CONSIGNE sont
// deux choses : à un prix normal, un collectible mis en vente pour se vérifier
// peut être ACHETÉ pour de bon, et la personne l'aurait perdu par notre faute.
// ⚠️ Première version de cet écran : la consigne était partie avec l'aveu.
// Retirer les deux d'un même geste, c'est confondre « ne pas se plaindre » et
// « ne pas protéger ».
// ⛔ L'ancien champ « 0x… » n'est pas SUPPRIMÉ, il est REPLIÉ derrière un
//    « Je connais mon adresse ». Quelqu'un qui la connaît vraiment n'a aucune
//    raison de faire deux mises en vente — et l'ancien parcours, éprouvé,
//    continue de tourner.

export function pageDecouvrir(erreur?: string, valeurs: { nom?: string; edition?: string }[] = []): string {
  const champ = (i: number) => `<div class="carte">
    <div class="rang"><b style="flex:1">Objet ${i + 1}</b></div>
    <input name="nom" list="catalogue" placeholder="Nom du collectible"
      value="${echapper(valeurs[i]?.nom ?? '')}"
      autocapitalize="off" autocomplete="off" spellcheck="false" required>
    <input name="edition" inputmode="numeric" pattern="[0-9]*" placeholder="N° de mint (ex. 253)"
      value="${echapper(valeurs[i]?.edition ?? '')}" required style="margin-top:8px">
  </div>`;
  return page('Retrouver votre portefeuille', `${entete('Votre portefeuille', '1 / 2')}
  ${erreur ? `<div class="err">${echapper(erreur)}</div>` : ''}
  <div class="carte">
    <p style="margin-top:0"><b>Vous n’avez pas besoin de votre adresse.</b></p>
    <p class="doux" style="margin:8px 0 0">Nommez ${NB_PAIRES} de vos <b>collectibles</b> avec leur
    numéro de mint, mettez-les en vente dans l’application VeVe, puis annulez.
    Nous les reconnaîtrons sur la chaîne — et c’est <b>votre</b> portefeuille qu’ils désigneront.</p>
    <p class="doux" style="margin:8px 0 0">⚠️ Des <b>collectibles</b>, pas des comics.
    Et deux objets qui vous appartiennent tous les deux : c’est ce qui fait la preuve.</p>
  </div>
  <form method="post" action="/decouvrir">
    ${CHAMP_PIEGE}
    ${Array.from({ length: NB_PAIRES }, (_, i) => champ(i)).join('')}
    <datalist id="catalogue"></datalist>
    <p style="margin:12px 0 0"><button>Continuer</button></p>
  </form>
  <p class="doux">Vous aurez ${FENETRE_DECOUVERTE} minutes pour faire le geste.</p>`,
  `<script>
/* ⭐ L'AUTOCOMPLÉTION AIDE, ELLE NE BLOQUE JAMAIS — arbitrage Preda du 07/08.
   Mesuré le même jour : le catalogue publié par veveprice ne couvre que 21 %
   des collectibles réellement mis en vente ; le catalogue COMPLET en couvre
   100 %. Un champ restreint refuserait donc 4 objets sur 5, et la personne le
   lirait comme SA faute. La vérité est la chaîne, jamais cette liste.
   ⛔ Et si la liste ne se charge pas, la page marche exactement pareil. */
(async () => {
  try {
    const r = await fetch('/catalogue.json', { headers: { accept: 'application/json' } });
    if (!r.ok) return;
    const noms = await r.json();
    const dl = document.getElementById('catalogue');
    for (const n of noms) { const o = document.createElement('option'); o.value = n; dl.appendChild(o); }
  } catch (e) { /* l'aide est absente, la saisie reste possible */ }
})();
</script>`);
}

export function pageDecouverte(a: AvancementDecouverte, id: string): string {
  const lignes = a.paires.map((c) => `<div class="ligne">
    <span class="coche ${c.vu ? 'vu' : ''}">${c.vu ? '✓' : ''}</span>
    <span><b>${echapper(c.nom)}</b> <span class="doux">#${c.edition}</span></span>
  </div>`).join('');
  return page('Vérification', `${entete('Vérification', '2 / 2')}
  <div class="carte">
    <p style="margin-top:0"><b>Mettez ces ${a.total} objets en vente dans l’application VeVe</b>, puis annulez.</p>
    <div class="err" style="background:#332b1e;border-color:var(--or)">
      🔴 <b>Mettez-les à un prix très élevé : entre ${prix(PRIX_MIN)} et ${prix(PRIX_MAX)}.</b>
      <p style="margin:6px 0 0">À un prix normal, quelqu’un peut les <b>acheter pour de bon</b>
      pendant la vérification — et vous auriez perdu votre collectible par notre faute.
      Personne n’achète à ${prix(PRIX_MIN)}.</p>
    </div>
    ${lignes}
    <p class="doux" style="margin:10px 0 0">La chaîne met <b>une à deux minutes</b> à enregistrer un
    geste : si ce n’est pas encore coché, ce n’est pas raté.</p>
  </div>
  <div class="carte">
    <div class="rang"><b id="compte">${a.faits}/${a.total}</b>
      <span class="jauge"><i id="barre" style="width:${(a.faits / a.total) * 100}%"></i></span></div>
    <p class="doux" id="msg" style="margin:10px 0 0">${echapper(a.message)}</p>
    <p class="doux" style="margin:6px 0 0">Il reste <b id="reste">${Math.ceil(a.restantSec / 60)}</b> minutes.</p>
  </div>
  <div class="carte" id="porte" style="display:none">
    <p style="margin-top:0"><b>Votre portefeuille a bien été reconnu.</b> Il est déjà
    rattaché à un compte — le plus souvent, un compte que vous aviez créé plus tôt.</p>
    <p style="margin:12px 0 0"><a class="bouton" href="/">Se connecter avec cette adresse</a></p>
    <p class="doux" style="margin:8px 0 0">Vous pouvez annuler vos deux mises en vente :
    la vérification est faite, elle n’a plus besoin d’elles.</p>
  </div>`, `<script>
const id=${enJson(id)};
async function sonder(){
  try{
    const r=await fetch('/decouverte.json?id='+encodeURIComponent(id),{headers:{accept:'application/json'}});
    const a=await r.json();
    document.getElementById('compte').textContent=a.faits+'/'+a.total;
    document.getElementById('barre').style.width=(a.faits/a.total*100)+'%';
    document.getElementById('reste').textContent=Math.ceil(a.restantSec/60);
    document.getElementById('msg').textContent=a.message;
    document.querySelectorAll('.coche').forEach((el,i)=>{
      if(a.paires[i]&&a.paires[i].vu){el.classList.add('vu');el.textContent='✓';}
    });
    if(a.etat==='trouve'){location.href='/compte?msg=' + encodeURIComponent('Portefeuille trouvé et vérifié.');return;}
    /* ⛔ Un refus RENVOIE au formulaire, il ne laisse pas devant une case qui
       ne se cochera plus. Le message est déjà affiché au-dessus. */
    /* 🔴 « déjà lié » NE RENVOIE PAS AU FORMULAIRE : refaire le geste ne peut
       pas mieux marcher, le portefeuille est trouvé et il appartient à un
       compte. On montre la PORTE — se connecter avec l'autre adresse. */
    if(a.etat==='deja_lie'){
      document.getElementById('porte').style.display='block';
      document.getElementById('msg').textContent=a.message;return;}
    if(a.etat==='deux_portefeuilles'||a.etat==='comic'||a.etat==='expire'){
      setTimeout(()=>{location.href='/decouvrir?msg='+encodeURIComponent(a.message);},4000);return;}
  }catch(e){}
  setTimeout(sonder,10000);
}
setTimeout(sonder,10000);
</script>`);
}

// ═══════════════════════════════════════════════════════════════════════
// 🔥 LOT 108 — LA PAGE D'EXPLOITATION
// ═══════════════════════════════════════════════════════════════════════
/**
 * ⛔⛔ ELLE NE CONTIENT AUCUNE ADRESSE EN CLAIR, ET UN BANC LE VÉRIFIE SUR
 *    LE HTML RENDU (`test/admin.test.ts`). Pas sur les fonctions : sur la
 *    chaîne finale. Une règle qui n'est vérifiée qu'à l'entrée se contourne
 *    par un chemin qu'on n'avait pas prévu.
 *
 * ⚠️ `noindex` est déjà posé par `page()` pour TOUT le service. On n'ajoute
 *    rien : deux façons de dire la même chose, et un jour l'une des deux
 *    change.
 */
const oui = (b: boolean) => (b ? '✅' : '—');
const nb = (n: number) => Number(n ?? 0).toLocaleString('fr-FR');

const blocForme = (f: Forme) => {
  const cols = f.colonnes.map((c) =>
    `<code>${echapper(c.nom)}</code> <span class="doux">${echapper(c.type || '?')}`
    + `${c.obligatoire ? ' · requis' : ''}${c.defaut ? ` · défaut ${echapper(c.defaut)}` : ''}</span>`)
    .join('<br>');
  const idx = f.index.map((i) =>
    `<div class="ligne"><span style="flex:1"><code>${echapper(i.nom)}</code>`
    + `<br><span class="doux">${i.unique ? 'unique' : 'simple'}${i.partiel ? ' · partiel' : ''}</span></span></div>`)
    .join('');
  const migs = f.migrations.length
    ? f.migrations.map((m) =>
      `<div class="ligne"><span style="flex:1">${echapper(m.valeur)}`
      + `<br><span class="doux">${echapper(m.maj)}</span></span></div>`).join('')
    /**
     * ⭐⭐⭐ « AUCUNE MIGRATION CONSIGNÉE » NE VEUT PAS DIRE « RIEN N'A
     * MIGRÉ ». Le journal en base date du lot 108 : tout ce qui a migré
     * AVANT n'y figure pas, et n'y figurera jamais. Le dire ici, à
     * l'endroit exact où on lirait le vide, est la seule façon d'empêcher
     * qu'on en tire la conclusion inverse — c'est très précisément
     * l'erreur du 07/08, répétée à l'envers.
     */
    : `<p class="doux" style="margin:0">Aucune migration consignée. ⚠️ Le journal
       en base commence au lot 108 : une migration ANTÉRIEURE n'y figure pas.
       Ce vide ne dit rien sur la forme de la base — c'est le bloc du dessus
       qui la dit.</p>`;
  return `<h2>Forme de la base</h2>
  <div class="carte">
    <div class="rang"><b>colonne <code>site</code></b> <span>${oui(f.site_present)}</span></div>
    <p class="doux" style="margin:10px 0 0">dernier démarrage : ${echapper(f.dernier_demarrage ?? 'inconnu')}</p>
  </div>
  <div class="carte"><b>comptes</b><p style="margin:8px 0 0;font-size:.9rem">${cols}</p></div>
  <div class="carte"><b>index</b>${idx || '<p class="doux">aucun</p>'}</div>
  <div class="carte"><b>journal de migration</b>${migs}</div>`;
};

const blocSites = (l: LigneSite[]) => `<h2>Comptes par site</h2>
  ${l.length ? l.map((s) => `<div class="carte">
    <div class="rang"><b style="flex:1">${echapper(s.site)}</b><span>${nb(s.total)}</span></div>
    <p class="doux" style="margin:8px 0 0">
      portefeuille : ${nb(s.avec_portefeuille)} · sans : ${nb(s.sans_portefeuille)}<br>
      vérifiés : ${nb(s.verifies)} · en délai de grâce : ${nb(s.en_grace)}</p>
  </div>`).join('') : '<div class="carte doux">Aucun compte.</div>'}`;

const blocActivite = (a: Activite) => `<h2>Activité</h2>
  <div class="carte">
    <div class="ligne"><span style="flex:1">découvertes <span class="doux">(lot 106)</span></span>
      <span>${nb(a.decouvertes.en_attente)} en attente</span></div>
    <div class="ligne"><span style="flex:1" class="doux">abouties / autres / aujourd’hui</span>
      <span>${nb(a.decouvertes.abouties)} / ${nb(a.decouvertes.autres)} / <b>${nb(a.decouvertes.aujourdhui)}</b></span></div>
    <div class="ligne"><span style="flex:1">défis <span class="doux">(par adresse)</span></span>
      <span>${nb(a.defis.en_attente)} en attente</span></div>
    <div class="ligne"><span style="flex:1">sessions actives</span><span>${nb(a.sessions_actives)}</span></div>
    <div class="ligne"><span style="flex:1">liens de connexion en cours</span><span>${nb(a.liens_en_cours)}</span></div>
    <div class="ligne"><span style="flex:1">avoirs enregistrés</span><span>${nb(a.avoirs)}</span></div>
  </div>`;

const blocRecherche = (t?: Trouvaille) => {
  let r = '';
  if (t && t.quoi === 'inconnu') {
    r = `<div class="err">Ce terme ne ressemble ni à une adresse e-mail ni à un
      portefeuille (<code>0x…</code>). Rien n’a été cherché.</div>`;
  } else if (t && !t.trouve) {
    r = `<div class="carte">Aucun compte pour ce ${t.quoi === 'email' ? 'courriel' : 'portefeuille'}.</div>`;
  } else if (t) {
    r = t.comptes.map((c) => `<div class="carte">
      <div class="rang"><b style="flex:1">${echapper(c.site)}</b>
        <span class="doux">créé le ${echapper(c.cree_le.slice(0, 10))}</span></div>
      <p class="doux" style="margin:8px 0 0">
        portefeuille : ${oui(c.a_un_portefeuille)} · vérifié : ${oui(c.verifie)}${
      c.verifie_le ? ` <span class="doux">(${echapper(c.verifie_le.slice(0, 10))})</span>` : ''}<br>
        ${c.indice_email ? `indice courriel : <b>${echapper(c.indice_email)}</b><br>` : ''}
        ${c.indice_wallet ? `indice portefeuille : <b>${echapper(c.indice_wallet)}</b><br>` : ''}
        ${c.abonne_jusqu_a ? `abonné jusqu’au ${echapper(c.abonne_jusqu_a.slice(0, 10))}<br>` : ''}
        ${c.en_grace ? `⚠️ suppression demandée le ${echapper(c.en_grace.slice(0, 10))}` : ''}</p>
      ${/* 🔴 LOT 122 — LE SEUL GESTE QUI ÉCRIT DE TOUTE CETTE PAGE.
            ⭐ Il est POSÉ PAR COMPTE, et pas une fois en haut de page : un
            même e-mail a un compte PAR SITE, et un formulaire unique aurait
            demandé de retaper le site — donc de le choisir à l'aveugle, donc
            de se tromper de compte sans le voir.
            ⚠️ `value` en dur et pas un champ libre pour le site : il vient du
            résultat, il n'est jamais saisi. Ce qu'on ne tape pas ne se
            trompe pas.
            ⛔ `min`/`max` côté HTML NE PROTÈGE RIEN — c'est du confort. La
            borne qui compte est dans `server.ts`, et elle y est. */ ''}
      <form method="post" action="/admin/abonner" class="rang" style="margin-top:10px;gap:8px">
        <input type="hidden" name="ref" value="${echapper(c.ref)}">
        <input name="jours" type="number" min="1" max="400" value="30"
               style="width:90px" aria-label="jours d’abonnement">
        <button class="principal">Accorder</button>
      </form>
    </div>`).join('');
  }
  return `<h2>Chercher un compte</h2>
  <div class="carte">
    <p class="doux" style="margin:0 0 10px">Une adresse e-mail ou un portefeuille
    <code>0x…</code>. Rien ne s’affiche tant qu’on ne demande pas — cette page ne
    liste personne.</p>
    <form method="post" action="/admin/chercher">
      <input name="q" autocomplete="off" spellcheck="false" placeholder="adresse ou 0x…">
      <button class="principal" style="margin-top:10px">Chercher</button>
    </form>
  </div>${r}`;
};

/**
 * ⚠️ LE TERME CHERCHÉ N'EST TOUJOURS PAS RÉAFFICHÉ, et ce lot a failli le
 *    changer. Il vient d'un POST (donc il n'est ni dans l'URL, ni dans
 *    l'historique, ni dans le `Referer`) : le remettre dans le HTML le
 *    redéposerait dans les trois.
 *
 * 🔴 LOT 122 — MA PREMIÈRE VERSION LE RENVOYAIT DANS UN CHAMP CACHÉ, pour que
 *    le formulaire d'abonnement sache sur quel compte il portait. Je m'étais
 *    convaincu que la règle ne visait que l'URL et l'historique, qu'un champ
 *    caché n'atteint pas. `test/admin.test.ts` a dit non : il lit le HTML
 *    RENDU et exige qu'aucune identité n'y figure, quel que soit le chemin.
 * ⭐⭐⭐ *Une règle vérifiée sur la SORTIE ne se contourne pas par un
 *    raisonnement sur son intention.* Le formulaire porte donc une RÉFÉRENCE
 *    OPAQUE (`c.ref`, l'uuid interne) : ni e-mail, ni portefeuille, rien à
 *    apprendre, et sans valeur hors d'une session d'exploitation.
 */
export function pageAdmin(
  f: Forme, sites: LigneSite[], a: Activite, t?: Trouvaille, message?: string,
): string {
  return page('Exploitation', `${entete('Exploitation', 'veve-id')}
  <div class="carte doux" style="margin-top:0">Cette page <b>regarde</b>, et depuis
  le lot 122 elle peut <b>accorder un abonnement</b> — le seul geste qui écrit.
  Elle n’affiche toujours aucune adresse en clair.</div>
  ${!message ? '' : `<div class="carte"><b>${echapper(message)}</b></div>`}
  ${blocRecherche(t)}
  ${blocForme(f)}
  ${blocSites(sites)}
  ${blocActivite(a)}
  <form method="post" action="/admin/sortir" style="margin-top:18px">
    <button class="danger">Fermer la session d’exploitation</button>
  </form>`);
}
