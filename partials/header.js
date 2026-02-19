// partials/header.js
// Shared site header with nav + auth slot showing "Name (HCP)" everywhere.

function loadHeader(activeKey){
  const root = document.getElementById("siteHeader");
  if(!root) return;

  const isActive = (k) => (k === activeKey ? "navTab navTabActive" : "navTab");

  root.innerHTML = `
    <div class="card" style="margin-top:12px;">
      <div class="hd" style="justify-content:space-between; flex-wrap:wrap;">
        <div class="row" style="gap:8px; flex-wrap:wrap;">
          <a href="./index.html" class="${isActive("home")}">Home</a>
          <a href="./draft.html" class="${isActive("draft")}">Draft</a>
          <a href="./rules.html" class="${isActive("rules")}">Rules</a>
          <a href="./signup.html" class="${isActive("signup")}">Sign Up</a>
        </div>

        <div id="authSlot"></div>
      </div>
    </div>
  `;

  renderAuthMini();
}

async function renderAuthMini(){
  const slot = document.getElementById("authSlot");
  if(!slot) return;

  const token = localStorage.getItem("sb_access_token");
  if(!token){
    slot.innerHTML = `<a class="navTab" href="./login.html">Log in</a>`;
    return;
  }

  try{
    const r = await fetch("/api/me", {
      headers: {
        "accept":"application/json",
        "authorization":"Bearer " + token
      }
    });

    const t = await r.text();
    if(!r.ok) throw new Error(t || r.statusText);

    const j = JSON.parse(t);
    const name = j?.player?.name || j?.user?.email || "Account";
    const h = j?.player?.handicap_index;

    const hText =
      (h === null || h === undefined || Number.isNaN(Number(h)))
        ? ""
        : `<small class="hcpInline">(${Number(h).toFixed(1)})</small>`;

    slot.innerHTML = `
      <div class="userMini">
        <span class="userMiniName">${name}${hText}</span>
        <a class="navTab" href="./login.html" id="logoutLink">Log out</a>
      </div>
    `;

    const logout = document.getElementById("logoutLink");
    if(logout){
      logout.addEventListener("click", (e) => {
        e.preventDefault();
        localStorage.removeItem("sb_access_token");
        window.location.href = "./login.html";
      });
    }
  }catch(e){
    localStorage.removeItem("sb_access_token");
    slot.innerHTML = `<a class="navTab" href="./login.html">Log in</a>`;
  }
}
