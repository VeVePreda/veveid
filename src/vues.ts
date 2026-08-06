import type { Avancement, Eligibles } from './defi.ts';
import { PRIX_MIN, PRIX_MAX, NB_CIBLES, FENETRE_MIN } from './defi.ts';
import type { Avoir, Compte } from './avoirs.ts';
import { DELAI_GRACE_JOURS } from './avoirs.ts';

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
    <form method="post" action="/lier-portefeuille">
      <input name="wallet" placeholder="0x…" inputmode="text" autocapitalize="off"
        autocomplete="off" spellcheck="false" required>
      <p style="margin:12px 0 0"><button>Vérifier mon portefeuille VeVe</button></p>
    </form>
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
