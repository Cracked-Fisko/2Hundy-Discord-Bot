import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
import fs from "fs";
dotenv.config();

const app = express();
const PORT = 3000;

const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI
} = process.env;

const FILE = "./verifiedUsers.json";

function getVerifiedUsers() {
  return JSON.parse(fs.readFileSync(FILE, "utf8") || "{}");
}

function saveVerifiedUsers(users) {
  fs.writeFileSync(FILE, JSON.stringify(users, null, 2));
}

// -------------------
// /authorize: start OAuth2
// -------------------
app.get("/authorize", (req, res) => {
  const { discordId } = req.query;
  if (!discordId) return res.status(400).send("Missing discordId");

  const discordAuthUrl =
    `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(DISCORD_REDIRECT_URI)}` +
    `&response_type=code&scope=identify%20connections` +
    `&state=${discordId}`;

  res.redirect(discordAuthUrl);
});

// -------------------
// /callback: handle Discord OAuth2 redirect
// -------------------
app.get("/callback", async (req, res) => {
  const { code, state: discordId } = req.query;
  if (!code || !discordId) return res.status(400).send("Missing code or discordId");

  try {
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: DISCORD_REDIRECT_URI,
        scope: "identify connections"
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.send("Failed to get access token.");

    const connRes = await fetch("https://discord.com/api/users/@me/connections", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` }
    });
    const connections = await connRes.json();

    const twitchConn = connections.find(c => c.type === "twitch");
    if (!twitchConn) return res.send("No Twitch account linked to your Discord.");

    const users = getVerifiedUsers();
    users[discordId] = { twitchId: twitchConn.id, twitchName: twitchConn.name };
    saveVerifiedUsers(users);

    res.send(`✅ Success! Linked Twitch account: ${twitchConn.name}`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error during OAuth flow.");
  }
});

app.listen(PORT, () => console.log(`🌐 OAuth2 server running on ${process.env.OAUTH_BASE_URL}`));
