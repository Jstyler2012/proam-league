// partials/header.js
async function loadHeader(activeKey){
  const host = document.getElementById("siteHeader");
  if(!host) return;

  // Always resolve relative to the current page (works on Netlify + static hosting)
  const url = new URL("./partials/header.html", document.baseURI);

  const res = await fetch(url.toString(), { cache: "no-cache" });
  if(!res.ok) throw new Error("Header fetch failed: " + res.status);

  host.innerHTML = await res.text();

  const active = host.querySelector(`[data-nav="${activeKey}"]`);
  if(active) active.classList.add("navTabActive");
}
