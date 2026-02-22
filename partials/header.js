// partials/header.js
// Shared site header with nav + auth slot.
// Option B behavior:
// - Logged out: show "Log in" tab
// - Logged in: show "Profile" tab + user mini + logout

function loadHeader(activeKey){
  const root = document.getElementById("siteHeader");
  if(!root) return;

  const isActive = (k) => (k === activeKey ? "navTab navTabActive" : "navTab");

  root.innerHTML = `
    <div class="card" style="margin-top:12px;">
      <div class="hd" style="justify-content:space-between; flex-wrap:wrap;">
        <div class="row" style="gap:8px; flex-wrap:wrap;" id="navRow">
          <a href="./index.html" class="${isActive("home")}">Home</a>
          <a href="./draft.html" class="${isActive("draft")}">Draft</a>
          <a href="./rules.html" class="${isActive("rules")}">Rules</a>

          <!-- Auth-dependent nav item goes here -->
          <span id="authNavItem"></span>
        </div>

        <div id="authSlot"></div>
      </div>
    </div>
  `;

  renderAuthNav(activeKey);
}

async function renderAuthNav(activeKey){
  const authNavItem = document.getElementById("authNavItem");
  const slot = document.getElementById("authSlot");
  if(!authNavItem || !slot) return;

  const isActive = (k) => (k === activeKey ? "navTab navTabActive" : "navTab");

  const token = localStorage.getItem("sb_access_token");
  if(!token){
    // Logged out: show Log in tab; no user mini
    authNavItem.innerHTML = `<a href="./login.html" class="${isActive("login")}">Log in</a>`;
    slot.innerHTML = ``;
    return;
  }

  // Logged in: show Profile tab + mini + logout
  authNavItem.innerHTML = `<a href="./profile.html" class="${isActive("profile")}">Profile</a>`;

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
        : `<small>(${Number(h).toFixed(1)})</small>`;

    slot.innerHTML = `
      <div class="userMiniActions">
        <div class="userMini">${name}${hText}</div>
        <a class="userMiniLink" href="./login.html" id="logoutLink">Log out</a>
      </div>
    `;

    const logoutLink = document.getElementById("logoutLink");
    if(logoutLink){
      logoutLink.addEventListener("click", async (e) => {
        e.preventDefault();
        localStorage.removeItem("sb_access_token");
        localStorage.removeItem("sb_refresh_token");
        window.location.href = "./login.html";
      });
    }

  }catch(e){
    // Token bad/expired
    localStorage.removeItem("sb_access_token");
    localStorage.removeItem("sb_refresh_token");

    authNavItem.innerHTML = `<a href="./login.html" class="${isActive("login")}">Log in</a>`;
    slot.innerHTML = ``;
  }
}
