async function loadHeader(activeKey){
  const host = document.getElementById("siteHeader");
  if(!host) return;

  const res = await fetch("./partials/header.html");
  host.innerHTML = await res.text();

  const active = host.querySelector(`[data-nav="${activeKey}"]`);
  if(active) active.classList.add("navTabActive");
}
