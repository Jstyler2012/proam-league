<!DOCTYPE html>
<html>
<head>
  <title>Login</title>
  <script src="https://unpkg.com/@supabase/supabase-js@2"></script>
  <script src="/supabase-config.js"></script>
</head>
<body>

<h2>Login</h2>

<form id="login-form">
  <input id="email" type="email" placeholder="Email" required />
  <input id="password" type="password" placeholder="Password" required />
  <button type="submit">Login</button>
</form>

<div id="msg"></div>

<script>
document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();

  const email = document.getElementById("email").value;
  const password = document.getElementById("password").value;

  const { data, error } = await window.sb.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    document.getElementById("msg").innerText = error.message;
    return;
  }

  document.getElementById("msg").innerText = "Login successful";
  window.location.href = "/";
});
</script>

</body>
</html>
