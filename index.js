import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionsBitField,
  ActivityType,
  EmbedBuilder,
} from "discord.js";
import fetch from "node-fetch";
import cron from "node-cron";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions, // Added intent for message reactions
  ],
});

const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  GUILD_ID,
  TWITCH_CLIENT_ID,
  TWITCH_CLIENT_SECRET,
  TWITCH_BROADCASTER_ID,
  YOUTUBE_API_KEY,
  YOUTUBE_CHANNEL_ID,
  DISCORD_ROLE_NAME,
  OAUTH_BASE_URL,
  STAFF_ROLE_ID,
  TICKET_MENU_CHANNEL_ID,
  TW_Chn,
  Socials_MENU_CHANNEL_ID,
  VOICE_MENU_CHANNEL_ID,
  GUIDELINES_CHANNEL_ID,
  ROLES_MENU_CHANNEL_ID,
  ROLE_GAMES_ID,
  ROLE_VIDEO_ID,
  ROLE_NOTIFY_ID,
} = process.env;

/* --------------------------
   File paths / safe read/write
   -------------------------- */
const DATA_DIR = ".";
const XP_FILE = path.join(DATA_DIR, "xp.json");
const VC_FILE = path.join(DATA_DIR, "vcChannels.json");
const TICKET_FILE = path.join(DATA_DIR, "tickets.json");
const VERIFIED_FILE = path.join(DATA_DIR, "verifiedUsers.json");
const BANNED_WORDS_FILE = path.join(DATA_DIR, "bannedWords.json");

function ensureFile(filePath, initial = "{}") {
  try {
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, initial);
  } catch (e) {
    console.error("Error ensuring file:", filePath, e);
  }
}
ensureFile(XP_FILE, "{}");
ensureFile(VC_FILE, "{}");
ensureFile(TICKET_FILE, "{}");
ensureFile(VERIFIED_FILE, "{}");
ensureFile(BANNED_WORDS_FILE, JSON.stringify({ words: [] }, null, 2));

function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8") || "{}");
  } catch (e) {
    console.error("readJSON error for", filePath, e);
    return {};
  }
}
function writeJSON(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error("writeJSON error for", filePath, e);
  }
}

/* --------------------------
   Basic state
   -------------------------- */
const bannedWords = (readJSON(BANNED_WORDS_FILE).words || []).map((w) =>
  w.toLowerCase()
);
const offenses = new Map(); // runtime offenses per user (not persisted)
const lastMessageTimestamps = new Map(); // userId -> timestamp of last message

/* --------------------------
   Twitch / YouTube helpers
   -------------------------- */
async function getTwitchToken() {
  const res = await fetch(
    `https://id.twitch.tv/oauth2/token?client_id=${TWITCH_CLIENT_ID}&client_secret=${TWITCH_CLIENT_SECRET}&grant_type=client_credentials`,
    { method: "POST" }
  );
  return res.json();
}

// Move Twitch helpers above verify command usage
function getUserAccessToken(discordId) {
  const verifiedUsers = readJSON(VERIFIED_FILE);
  const user = verifiedUsers[discordId];
  return user && user.twitchAccessToken ? user.twitchAccessToken : null;
}

async function isTwitchSub(userId, discordId) {
  try {
    let accessToken = getUserAccessToken(discordId);
    if (!accessToken) {
      const tokenData = await getTwitchToken();
      accessToken = tokenData.access_token;
    }
    const res = await fetch(
      `https://api.twitch.tv/helix/subscriptions?broadcaster_id=${TWITCH_BROADCASTER_ID}&user_id=${userId}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Client-Id": TWITCH_CLIENT_ID,
        },
      }
    );
    const data = await res.json();
    return data.data && data.data.length > 0;
  } catch (e) {
    console.error("isTwitchSub error", e);
    return false;
  }
}

async function isTwitchFollower(twitchUserId, discordId) {
  try {
    let accessToken = getUserAccessToken(discordId);
    if (!accessToken) {
      const tokenData = await getTwitchToken();
      accessToken = tokenData.access_token;
    }
    const url = `https://api.twitch.tv/helix/channels/followers?broadcaster_id=${TWITCH_BROADCASTER_ID}&user_id=${twitchUserId}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Client-Id": TWITCH_CLIENT_ID,
      },
    });
    const data = await res.json();
    return data.data && data.data.length > 0;
  } catch (e) {
    console.error("isTwitchFollower error", e);
    return null;
  }
}

async function isTwitchLive() {
  try {
    const tokenData = await getTwitchToken();
    const res = await fetch(
      `https://api.twitch.tv/helix/streams?user_id=${TWITCH_BROADCASTER_ID}`,
      {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          "Client-Id": TWITCH_CLIENT_ID,
        },
      }
    );
    const data = await res.json();
    return data.data && data.data.length > 0 ? data.data[0] : null;
  } catch (e) {
    console.error("isTwitchLive error", e);
    return null;
  }
}

async function getLatestYouTubeVideo() {
  try {
    const channelRes = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${YOUTUBE_CHANNEL_ID}&key=${YOUTUBE_API_KEY}`
    );
    const channelData = await channelRes.json();
    if (!channelData.items || !channelData.items.length) return null;
    const uploadsPlaylist = channelData.items[0].contentDetails.relatedPlaylists.uploads;

    const playlistRes = await fetch(
      `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=1&playlistId=${uploadsPlaylist}&key=${YOUTUBE_API_KEY}`
    );
    const playlistData = await playlistRes.json();
    if (!playlistData.items || !playlistData.items.length) return null;
    const latest = playlistData.items[0].snippet;

    return {
      id: latest.resourceId.videoId,
      title: latest.title,
      url: `https://www.youtube.com/watch?v=${latest.resourceId.videoId}`,
      thumbnail: latest.thumbnails.medium.url,
    };
  } catch (e) {
    console.error("getLatestYouTubeVideo error", e);
    return null;
  }
}

async function isYouTubeLive() {
  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${YOUTUBE_CHANNEL_ID}&eventType=live&type=video&key=${YOUTUBE_API_KEY}`
    );
    const data = await res.json();
    return data.items && data.items.length > 0 ? data.items[0] : null;
  } catch (e) {
    console.error("isYouTubeLive error", e);
    return null;
  }
}

/* --------------------------
   Presence update
   -------------------------- */
async function updatePresence() {
  try {
    const live = await isTwitchLive();

    if (live) {
      client.user.setPresence({
        status: "online",
        activities: [
          {
            name: "J2hundred on Twitch",
            type: ActivityType.Streaming,
            url: "https://www.twitch.tv/J2hundred",
          },
        ],
      });
    } else {
      client.user.setPresence({
        status: "online",
        activities: [
          {
            name: "J2hundred on YouTube",
            type: ActivityType.Watching,
          },
        ],
      });
    }
  } catch (e) {
    console.error("updatePresence error", e);
  }
}

/* --------------------------
   XP system helpers
   -------------------------- */
function getXPData() {
  return readJSON(XP_FILE) || {};
}
function saveXPData(data) {
  writeJSON(XP_FILE, data);
}

/* --------------------------
   VC tracking
   store { ownerId: { voiceChannelId, controlMessageId, controlChannelId } }
   -------------------------- */
function getVChData() {
  return readJSON(VC_FILE) || {};
}
function saveVChData(data) {
  writeJSON(VC_FILE, data);
}

/* --------------------------
   Tickets helpers
   -------------------------- */
function getTickets() {
  return readJSON(TICKET_FILE) || {};
}
function saveTickets(tickets) {
  writeJSON(TICKET_FILE, tickets);
}

/* --------------------------
   Verified users helpers
   -------------------------- */
function getVerifiedUsers() {
  return readJSON(VERIFIED_FILE) || {};
}
function saveVerifiedUsers(obj) {
  writeJSON(VERIFIED_FILE, obj);
}

/* --------------------------
   Utility: pretty leaderboard text
   -------------------------- */
function pad(n, l = 2) {
  return String(n).padStart(l, " ");
}

/* --------------------------
   Voice Channel Controller UI
   - flexible: accepts either a channel object or channel id
   -------------------------- */
async function createVoiceChannelController(ownerId, voiceChannelRef) {
  if (!VOICE_MENU_CHANNEL_ID) {
    console.error("❌ VOICE_MENU_CHANNEL_ID not set in .env");
    return null;
  }

  const guild = client.guilds.cache.first(); // or fetch by ID if you know the guild
  const user = await client.users.fetch(ownerId).catch(() => null);

  // Create private controller text channel
  const controllerChannel = await guild.channels.create({
    name: `vc-${user?.username || ownerId}-control`,
    type: ChannelType.GuildText,
    permissionOverwrites: [
      { id: guild.roles.everyone, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: ownerId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
      { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.EmbedLinks] }
    ]
  });

  // Build embed
  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`${user?.username || "User"}'s VC Controller`)
    .setDescription(
      `Manage your voice channel: ${voiceChannelRef ? `<#${voiceChannelRef.id || voiceChannelRef}>` : "❓ Unknown VC"}\n\nUse the buttons below to control your VC.`
    )
    .setFooter({ text: "2Hundy VC Manager" })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`vc_lock_${ownerId}`).setLabel("🔒 Lock").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`vc_unlock_${ownerId}`).setLabel("🔓 Unlock").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`vc_rename_${ownerId}`).setLabel("✏️ Rename").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`vc_invite_${ownerId}`).setLabel("🤝 Invite").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`vc_delete_${ownerId}`).setLabel("🗑️ Delete").setStyle(ButtonStyle.Secondary),
  );

  const msg = await controllerChannel.send({ embeds: [embed], components: [row] });

  // Save mapping
  const vch = getVChData();
  vch[ownerId] = {
    voiceChannelId: voiceChannelRef?.id || null,
    controlMessageId: msg.id,
    controlChannelId: controllerChannel.id,
  };
  saveVChData(vch);

  return msg.id;
}

/* --------------------------
   Ready
   -------------------------- */
client.on("clientReady", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // send socials links on ready (once)
  await postSocialsMessage();
// Function to post socials message
async function postSocialsMessage() {
  try {
    const channel = await client.channels.fetch(Socials_MENU_CHANNEL_ID).catch(() => null);
    if (channel && channel.isTextBased()) {
      const socials = [
        { name: "Twitch", url: `https://twitch.tv/${TW_Chn}` },
        { name: "YouTube", url: `https://www.youtube.com/channel/${YOUTUBE_CHANNEL_ID}` },
      ];
      await channel.send({ content: socials.map((s) => `🔗 **${s.name}:** ${s.url}`).join("\n") });
      return true;
    }
    return false;
  } catch (e) {
    console.error("Failed posting socials:", e);
    return false;
  }
}

  // Post ticket menu
  sendTicketMenu().catch((e) => console.error("sendTicketMenu error:", e));
  postRolesEmbed();
  // Post a permanent VC hub/menu if not present
  try {
    await sendVCMenu();
  } catch (e) {
    console.error("sendVCMenu error:", e);
  }

  // Restore per-user controller messages for existing mappings (if control message missing, recreate)
  try {
    const vch = getVChData();
    for (const ownerId of Object.keys(vch)) {
      const entry = vch[ownerId];
      // attempt to fetch existing control message
      if (!entry.controlChannelId || !entry.controlMessageId) {
        // recreate controller message (don't create a channel here)
        await createVoiceChannelController(ownerId, entry.voiceChannelId).catch((e) => console.error("recreate controller error", e));
        continue;
      }

      const ch = await client.channels.fetch(entry.controlChannelId).catch(() => null);
      if (!ch || !ch.isTextBased()) {
        // recreate in default VOICE_MENU_CHANNEL_ID
        await createVoiceChannelController(ownerId, entry.voiceChannelId).catch((e) => console.error("recreate controller error", e));
        continue;
      }

      const msg = await ch.messages.fetch(entry.controlMessageId).catch(() => null);
      if (!msg) {
        // recreate
        await createVoiceChannelController(ownerId, entry.voiceChannelId).catch((e) => console.error("recreate controller error", e));
      }
    }
  } catch (e) {
    console.error("restore controllers error:", e);
  }

  // presence update
  updatePresence();
  setInterval(updatePresence, 5 * 60 * 1000);
});

/* --------------------------
   Tickets: menu & helpers
   -------------------------- */
async function sendTicketMenu() {
  try {
    const channel = await client.channels.fetch(TICKET_MENU_CHANNEL_ID).catch(() => null);
    if (!channel?.isTextBased()) return;

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("open_ticket").setLabel("🎟️ Open Ticket").setStyle(ButtonStyle.Primary)
    );

    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle("🎫 Ticketing System")
      .setDescription("Welcome! Click the button below to open a ticket.")
      .setFooter({ text: "Support without clutter" })
      .setTimestamp();

    await channel.send({ embeds: [embed], components: [row] });
    console.log("✅ Ticket menu posted.");
  } catch (e) {
    console.error("sendTicketMenu error:", e);
  }
}

/* --------------------------
   Permanent VC hub menu (single persistent menu message)
   - posts a single hub message with a Create button
   -------------------------- */
async function sendVCMenu() {
  if (!VOICE_MENU_CHANNEL_ID) return console.error("VOICE_MENU_CHANNEL_ID not set");
  const channel = await client.channels.fetch(VOICE_MENU_CHANNEL_ID).catch(() => null);
  if (!channel?.isTextBased()) return console.error("VOICE_MENU_CHANNEL_ID invalid or not text-based");

  // Optionally: check if a similar message already exists (naive approach: skip duplicate posting within last 50 messages)
  try {
    const recent = await channel.messages.fetch({ limit: 50 });
    const found = recent.find((m) => m.author.id === client.user.id && m.components?.length && m.embeds?.length && m.embeds[0].title === "🎛️ Voice Channel Manager");
    if (found) return; // don't repost
  } catch (e) {
    // ignore fetch errors and continue to post
  }

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle("🎛️ Voice Channel Manager")
    .setDescription("Create and manage your own custom voice channel using the buttons below.\n\n⚠️ You must be at least **Level 1** to create a VC.")
    .setFooter({ text: "2Hundy VC Manager" })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("vc_create").setLabel("➕ Create VC").setStyle(ButtonStyle.Success)
  );

  await channel.send({ embeds: [embed], components: [row] });
}

/* --------------------------
   Unified messageCreate:
   - moderation
   - xp awarding (non-violating messages)
   -------------------------- */
client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;
    const userId = message.author.id;
    const content = (message.content || "").toLowerCase();
    const hasLink = /(https?:\/\/[^\s]+)/.test(content);
    const hasAttachment = message.attachments.size > 0;
    const hasBannedWord = bannedWords.some((w) => w && content.includes(w));

    // --- Spam protection ---
    const now = Date.now();
    const lastTs = lastMessageTimestamps.get(userId) || 0;
    if (now - lastTs < 1000) { // less than 1s between messages
      // treat as spam
      let count = offenses.get(userId) || 0;
      count++;
      offenses.set(userId, count);
      lastMessageTimestamps.set(userId, now);
      try {
        if (message.deletable) await message.delete();
      } catch (err) {
        console.error("Failed to delete spam message:", err);
      }
      let member;
      try {
        member = await message.guild.members.fetch(userId);
      } catch (err) {
        member = null;
      }
      try {
        if (count === 1) {
          await message.channel.send(`⚠️ <@${userId}>, please slow down! Spam is not allowed.`);
        } else if (count === 2) {
          if (member?.moderatable) {
            await member.timeout(5 * 60 * 1000, "Spam (2nd offense)");
            await message.channel.send(`⏱️ <@${userId}>, you’ve been timed out for 5 minutes (spam).`);
          } else {
            await message.channel.send(`⚠️ <@${userId}>, warning: bot cannot timeout you, but your spam message was removed.`);
          }
        } else if (count >= 3) {
          if (member?.moderatable) {
            await member.timeout(60 * 60 * 1000, "Spam (3rd offense)");
            await message.channel.send(`⏱️ <@${userId}>, you’ve been timed out for 1 hour (spam).`);
          } else {
            await message.channel.send(`⚠️ <@${userId}>, warning: bot cannot timeout you, but your spam message was removed.`);
          }
        }
      } catch (err) {
        await message.channel.send(`⚠️ Error applying spam moderation to <@${userId}>.`);
      }
      return;
    }
    lastMessageTimestamps.set(userId, now);

    if (hasLink || hasAttachment || hasBannedWord) {
      // moderation
      let count = offenses.get(userId) || 0;
      count++;
      offenses.set(userId, count);
      try {
        if (message.deletable) await message.delete();
      } catch (err) {
        console.error("Failed to delete message:", err);
      }
      let member;
      try {
        member = await message.guild.members.fetch(userId);
      } catch (err) {
        member = null;
      }
      try {
        if (count === 1) {
          await message.channel.send(`⚠️ <@${userId}>, that’s not allowed here. Your message has been removed.`);
        } else if (count === 2) {
          if (member?.moderatable) {
            await member.timeout(5 * 60 * 1000, "2nd offense");
            await message.channel.send(`⏱️ <@${userId}>, you’ve been timed out for 5 minutes (2nd offense).`);
          } else {
            await message.channel.send(`⚠️ <@${userId}>, warning: bot cannot timeout you, but your message was removed.`);
          }
        } else if (count >= 3) {
          if (member?.moderatable) {
            await member.timeout(60 * 60 * 1000, "3rd offense");
            await message.channel.send(`⏱️ <@${userId}>, you’ve been timed out for 1 hour (3rd offense).`);
          } else {
            await message.channel.send(`⚠️ <@${userId}>, warning: bot cannot timeout you, but your message was removed.`);
          }
        }
      } catch (err) {
        await message.channel.send(`⚠️ Error applying moderation to <@${userId}>. Check bot permissions.`);
      }
      // do NOT award XP for violating messages
      return;
    }

    // ---- XP awarding (non-violating messages) ----
    try {
      const xpData = getXPData();
      if (!xpData[userId]) xpData[userId] = { xp: 0, level: 0 };
      xpData[userId].xp += 0.05;
      const neededXP = (xpData[userId].level + 1) * 200;
      if (xpData[userId].xp >= neededXP) {
        xpData[userId].level += 1;
        await message.channel.send(`🎉 Congrats <@${userId}>, you reached **Level ${xpData[userId].level}!**`);
        // Role assignment logic
        const guild = message.guild;
        const levelRoleName = `Level ${xpData[userId].level}`;
        let role = guild.roles.cache.find(r => r.name === levelRoleName);
        if (!role) {
          await guild.roles.create({
            name: levelRoleName,
            color: 0x3498db,
            reason: `Auto-created for level ${xpData[userId].level}`
          });
          await guild.roles.fetch();
          role = guild.roles.cache.find(r => r.name === levelRoleName);
          let ticketChannel = null;
          try {
            ticketChannel = await guild.channels.create({
              name: `ticket-level${xpData[userId].level}`,
              type: ChannelType.GuildText,
              permissionOverwrites: [
                { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                { id: String(userId), allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
                ...(STAFF_ROLE_ID ? [{ id: String(STAFF_ROLE_ID), allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }] : []),
              ],
            });
          } catch (err) {
            console.error('Failed to create ticket channel for level-up:', err);
          }
          if (ticketChannel) {
            const tickets = getTickets();
            tickets[ticketChannel.id] = { userId, status: "open", reason: `Role ${levelRoleName} auto-created` };
            saveTickets(tickets);
            const row = new ActionRowBuilder().addComponents(
              new ButtonBuilder().setCustomId("close_ticket").setLabel("Close Ticket").setStyle(ButtonStyle.Danger)
            );
            await ticketChannel.send({ content: `A new role **${levelRoleName}** was auto-created and assigned to <@${userId}>. Staff, please review.`, components: [row] });
          }
        }
        const member = await guild.members.fetch(userId);
        if (role && !member.roles.cache.has(role.id)) await member.roles.add(role);
      }
      saveXPData(xpData);
    } catch (e) {
      console.error("XP system error:", e);
    }
  } catch (err) {
    console.error("messageCreate outer error:", err);
  }
});

/* --------------------------
   Unified interactionCreate
   Handles:
   - slash commands
   - modal submits
   - button presses (tickets, VC controls)
   -------------------------- */
client.on("interactionCreate", async (interaction) => {
  try {
    // Slash commands
    if (interaction.isCommand()) {
      if (interaction.commandName === "clear") {
        // Only allow users with ManageMessages permission
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (!member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
          return interaction.reply({ content: "❌ You don't have permission to clear messages.", ephemeral: true });
        }
        const amount = parseInt(interaction.options.getInteger("amount"), 10) || 10;
        const channel = interaction.channel;
        try {
          const deleted = await channel.bulkDelete(amount, true);
          await interaction.reply({ content: `✅ Deleted ${deleted.size} messages.`, ephemeral: true });
        } catch (e) {
          await interaction.reply({ content: `❌ Failed to delete messages: ${e.message}`, ephemeral: true });
        }
        return;
      }
      if (interaction.commandName === "verify") {
        const verifiedUsers = getVerifiedUsers();
        const userData = verifiedUsers[interaction.user.id];
        if (!userData || !userData.twitchName || !userData.twitchAccessToken) {
          const url = `${OAUTH_BASE_URL}/authorize?discordId=${interaction.user.id}`;
          return interaction.reply({ content: `Click here to link your Twitch account: ${url}`, flags: 64 });
        }
        try {
          // Use user access token for all Twitch API calls
          const accessToken = userData.twitchAccessToken;
          const userRes = await fetch(`https://api.twitch.tv/helix/users?id=${userData.twitchId}`, {
            headers: { "Client-Id": TWITCH_CLIENT_ID, Authorization: `Bearer ${accessToken}` },
          });
          const userJson = await userRes.json();
          if (!userJson.data || userJson.data.length === 0)
            return interaction.reply({ content: "❌ Could not find Twitch account.", flags: 64 });
          const twitchUserId = userJson.data[0].id;
          // Check subscription
          const subRes = await fetch(
            `https://api.twitch.tv/helix/subscriptions?broadcaster_id=${TWITCH_BROADCASTER_ID}&user_id=${twitchUserId}`,
            { headers: { "Client-Id": TWITCH_CLIENT_ID, Authorization: `Bearer ${accessToken}` } }
          );
          const subData = await subRes.json();
          const member = await interaction.guild.members.fetch(interaction.user.id);
          const role = interaction.guild.roles.cache.get(DISCORD_ROLE_NAME);
          if (role && !member.roles.cache.has(role.id) && subData.data && subData.data.length > 0) await member.roles.add(role);
          // Follower check
          const followerRes = await fetch(
            `https://api.twitch.tv/helix/channels/followers?broadcaster_id=${TWITCH_BROADCASTER_ID}&user_id=${twitchUserId}`,
            { headers: { "Client-Id": TWITCH_CLIENT_ID, Authorization: `Bearer ${accessToken}` } }
          );
          const followerData = await followerRes.json();
          const isFollower = followerData.data && followerData.data.length > 0;
          if (isFollower) {
            const kingJimRole = interaction.guild.roles.cache.find(r => r.name === "KingJim");
            if (kingJimRole && !member.roles.cache.has(kingJimRole.id)) {
              await member.roles.add(kingJimRole);
            }
          }
          if (subData.data && subData.data.length > 0) {
            return interaction.reply({ content: `✅ You are subscribed! Role added.${isFollower ? " You are also a follower and have been granted the KingJim role." : ""}`, flags: 64 });
          } else if (isFollower) {
            return interaction.reply({ content: `✅ You are not subscribed, but you follow the channel. You have been granted the KingJim role.`, flags: 64 });
          } else {
            return interaction.reply({ content: "❌ You are not subscribed or following the Twitch channel.", flags: 64 });
          }
        } catch (e) {
          console.error("verify command error:", e);
          return interaction.reply({ content: "❌ Verification failed (internal error).", flags: 64 });
        }
      }

      if (interaction.commandName === "rank") {
        const xpData = getXPData();
        const user = xpData[interaction.user.id] || { xp: 0, level: 0 };
        return interaction.reply({
          content: `⭐ <@${interaction.user.id}> — Level: **${user.level}**, XP: **${user.xp.toFixed(2)}**`,
          ephemeral: true,
        });
      }

      if (interaction.commandName === "leaderboard") {
        const xpData = getXPData();
        const sorted = Object.entries(xpData)
          .sort(([, a], [, b]) => b.xp - a.xp)
          .slice(0, 10);

        const embed = new EmbedBuilder()
          .setColor(0xffd700)
          .setTitle("🏆 XP Leaderboard")
          .setDescription(
            sorted
              .map(([id, data], i) => `**${i + 1}.** <@${id}> — Level: **${data.level}** | XP: **${data.xp.toFixed(2)}**`)
              .join("\n")
          )
          .setFooter({ text: "2Hundy XP System" })
          .setTimestamp();

        return interaction.reply({ embeds: [embed] });
      }

      if (interaction.commandName === "rsocial") {
        // Only allow users with ManageMessages permission
        const member = await interaction.guild.members.fetch(interaction.user.id);
        if (!member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
          return interaction.reply({ content: "❌ You don't have permission to refresh socials.", ephemeral: true });
        }
        // Instantly post socials message in the current channel, including latest YouTube video
        const socials = [   ];
        let ytVideoText = "";
        try {
          const latestVideo = await getLatestYouTubeVideo();
          if (latestVideo) {
            ytVideoText = `▶️ **Latest YouTube Video:** [${latestVideo.title}](${latestVideo.url})`;
          }
        } catch {}
        try {
          await interaction.channel.send({ content: [
            socials.map((s) => `🔗 **${s.name}:** ${s.url}`).join("\n"),
            ytVideoText
          ].filter(Boolean).join("\n\n") });
        } catch (e) {
          // ignore channel send error
        }
        // Always respond to the interaction so Discord doesn't timeout
        if (!interaction.replied && !interaction.deferred) {
          try {
            await interaction.reply({ content: "✅ Socials message posted.", ephemeral: true });
          } catch (e) {
            // ignore reply error
          }
        }
        return;
      }

      if (interaction.commandName === "guidelines") {
        const member = await interaction.guild.members.fetch(interaction.user.id);
        
        if (!member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
          return interaction.reply({ content: "❌ You don't have permission to post guidelines.", ephemeral: true });
        }
        await postGuidelinesMessage();
        return interaction.reply({ content: "✅ Guidelines posted.", ephemeral: true });
      }
    }

// Modal submits (VC rename)
if (interaction.isModalSubmit()) {
  if (interaction.customId && interaction.customId.startsWith("vc_rename_modal_")) {
    const ownerId = interaction.customId.split("_").slice(-1)[0];
    const vch = getVChData();
    const entry = vch[ownerId];

    if (!entry || !entry.voiceChannelId) {
      return interaction.reply({ content: "❌ VC record not found.", ephemeral: true });
    }

    // Allow either the owner or admins/managers
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (interaction.user.id !== ownerId &&
        !member.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
      return interaction.reply({ content: "❌ You don't have permission to rename this VC.", ephemeral: true });
    }

    const newName = interaction.fields.getTextInputValue("vc_new_name").slice(0, 90);
    const lower = newName.toLowerCase();
    const hasBanned = bannedWords.some((w) => lower.includes(w));

    try {
      const vc = await interaction.guild.channels.fetch(entry.voiceChannelId);
      if (!vc) throw new Error("VC not found");

      if (hasBanned) {
        await vc.setName(`${interaction.user.username}'s VC`);
        return interaction.reply({
          content: "⚠️ That name contains a banned word. Reset to default instead.",
          ephemeral: true,
        });
      } else {
        await vc.setName(newName);
        return interaction.reply({
          content: `✏️ Channel renamed to **${newName}**`,
          ephemeral: true,
        });
      }
    } catch (e) {
      console.error("vc rename modal error", e);
      return interaction.reply({ content: "❌ Failed to rename channel.", ephemeral: true });
    }
  } else if (interaction.customId && interaction.customId.startsWith("vc_invite_modal_")) {
    const ownerId = interaction.customId.split("_").slice(-1)[0];
    const vch = getVChData();
    const entry = vch[ownerId];
    if (!entry || !entry.voiceChannelId) {
      return interaction.reply({ content: "❌ VC record not found.", flags: 64 });
    }
    const member = await interaction.guild.members.fetch(interaction.user.id);
    if (interaction.user.id !== ownerId && !member.permissions.has(PermissionsBitField.Flags.ManageChannels)) {
      return interaction.reply({ content: "❌ You don't have permission to invite users to this VC.", flags: 64 });
    }
    const raw = interaction.fields.getTextInputValue("vc_invite_user").trim();
    // Accept user ID or mention
    let targetId = null;
    const mentionMatch = raw.match(/<@!?([0-9]{17,19})>/);
    if (mentionMatch) {
      targetId = mentionMatch[1];
    } else {
      const idMatch = raw.match(/\d{17,19}/);
      if (idMatch) targetId = idMatch[0];
    }
    if (!targetId) {
      return interaction.reply({ content: "❌ Provide a valid user ID or mention.", flags: 64 });
    }
    if (targetId === ownerId) {
      return interaction.reply({ content: "⚠️ You are already the owner of this VC.", flags: 64 });
    }
    let voiceChannel = null;
    try {
      voiceChannel = await interaction.guild.channels.fetch(entry.voiceChannelId).catch(() => null);
    } catch {}
    if (!voiceChannel) {
      return interaction.reply({ content: "❌ Voice channel not found.", flags: 64 });
    }
    // Add invited user to voice channel permissions
    let invitedMember = null;
    try {
      invitedMember = await interaction.guild.members.fetch(targetId);
      await voiceChannel.permissionOverwrites.edit(invitedMember.id, { Connect: true });
    } catch (e) {
      console.error("Failed to add user to VC permissions:", e);
      return interaction.reply({ content: "❌ Failed to add user to VC permissions.", flags: 64 });
    }
    let invite;
    try {
      invite = await voiceChannel.createInvite({ maxUses: 1, unique: true, maxAge: 3600 });
    } catch (e) {
      console.error("createInvite error", e);
      return interaction.reply({ content: "❌ Failed to create invite (permissions?).", flags: 64 });
    }
    let targetUser = null;
    try {
      targetUser = await interaction.client.users.fetch(targetId).catch(() => null);
    } catch {}
    let dmSent = false;
    if (targetUser) {
      try {
        await targetUser.send(`🤝 You have been invited to join a voice channel by <@${ownerId}>: ${invite.url}`);
        dmSent = true;
      } catch {
        dmSent = false;
      }
    }
    return interaction.reply({
      content: dmSent
        ? `✅ Invite created and DM sent to <@${targetId}>! (Expires in 1h / 1 use)\n🔓 You have also been granted access to the VC.`
        : `✅ Invite created: ${invite.url}\n🔓 You have also been granted access to the VC.\n⚠️ Could not DM <@${targetId}>. Share the link manually.`,
      flags: 64,
    });
  }
}

// Buttons
    if (interaction.isButton()) {
      const id = interaction.customId || "";

      // Tickets
      if (id === "open_ticket") {
        const tickets = getTickets();
        if (Object.values(tickets).some((t) => t.userId === interaction.user.id)) {
          await interaction.reply({ content: "❌ You already have an open ticket.", ephemeral: true });
          return;
        }

        try {
          const guild = interaction.guild;
          const channel = await guild.channels.create({
            name: `ticket-${interaction.user.username}`,
            type: ChannelType.GuildText,
            permissionOverwrites: [
              { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
              { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
              ...(STAFF_ROLE_ID ? [{ id: STAFF_ROLE_ID, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] }] : []),
            ],
          });

          tickets[channel.id] = { userId: interaction.user.id, status: "open" };
          saveTickets(tickets);

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("close_ticket").setLabel("Close Ticket").setStyle(ButtonStyle.Danger)
          );

          await channel.send({ content: `Hello <@${interaction.user.id}>, support will be with you shortly.`, components: [row] });
          await interaction.reply({ content: `✅ Ticket created: ${channel}`, ephemeral: true });
        } catch (e) {
          console.error("open_ticket error", e);
          await interaction.reply({ content: "❌ Failed to create ticket. Check bot permissions.", ephemeral: true });
        }

        return;
      }

      if (id === "close_ticket") {
        const tickets = getTickets();
        const ticket = tickets[interaction.channel.id];
        if (!ticket) {
          await interaction.reply({ content: "❌ Ticket not found.", ephemeral: true });
          return;
        }
        delete tickets[interaction.channel.id];
        saveTickets(tickets);
        await interaction.channel.send("🔒 Ticket closed. Channel will be deleted in 3 seconds.");
        setTimeout(() => interaction.channel.delete().catch(() => {}), 3000);
        return;
      }
      // Permanent VC hub create button
      if (id === "vc_create") {
        const userId = interaction.user.id;
        const guild = interaction.guild;

        const xpData = getXPData();
        const userStats = xpData[userId] || { xp: 0, level: 0 };

        if (userStats.level < 1) {
          return interaction.reply({ content: "⚠️ You must be at least **Level 1** to create a custom voice channel.", ephemeral: true });
        }

        const vch = getVChData();
        if (vch[userId]?.voiceChannelId) {
          try {
            const existing = await guild.channels.fetch(vch[userId].voiceChannelId);
            if (existing) {
              return interaction.reply({ content: `⚠️ You already have a voice channel: ${existing}`, ephemeral: true });
            }
          } catch {
            // channel missing, allow re-creation
          }
        }

const safeName = `${interaction.user.username}`.slice(0, 90);

try {
  // Create the voice channel
  const voiceChannel = await guild.channels.create({
    name: `${safeName}'s VC`,
    type: ChannelType.GuildVoice,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, allow: [PermissionsBitField.Flags.Connect] },
      { id: userId, allow: [PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.Connect] },
    ],
  });

  // Create a text channel for controls
  const controlChannel = await guild.channels.create({
    name: `${safeName}-vc-controls`,
    type: ChannelType.GuildText,
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] }, // hide from everyone
      { id: userId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages] },
    ],
    parent: voiceChannel.parent ?? null, // keep in same category if possible
  });

  // Save record
  vch[userId] = {
    voiceChannelId: voiceChannel.id,
    controlChannelId: controlChannel.id,
  };
  saveVChData(vch);

  // Build controller embed
  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`${interaction.user.username}'s VC Controller`)
    .setDescription(`Manage your voice channel: ${voiceChannel}\n\nUse the buttons below to control your VC.`)
    .setFooter({ text: "2Hundy VC Manager" })
    .setTimestamp();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`vc_lock_${userId}`).setLabel("🔒 Lock").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`vc_unlock_${userId}`).setLabel("🔓 Unlock").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`vc_rename_${userId}`).setLabel("✏️ Rename").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`vc_invite_${userId}`).setLabel("🤝 Invite").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`vc_delete_${userId}`).setLabel("🗑️ Delete").setStyle(ButtonStyle.Secondary),
  );

  // Send controller message into the private control text channel
  await controlChannel.send({ embeds: [embed], components: [row] });

  return interaction.reply({
    content: `✅ Your voice channel has been created: ${voiceChannel}\n🔗 Controller posted in ${controlChannel}`,
    ephemeral: true,
  });

} catch (e) {
  console.error("vc_create error:", e);
  return interaction.reply({
    content: "❌ Failed to create voice channel. Check bot permissions.",
    ephemeral: true,
  });
}
      }

      // VC controls (button ids: vc_action_ownerId)
      if (id.startsWith("vc_")) {
        const parts = id.split("_");
        const action = parts[1];
        const ownerId = parts[2];
        if (!ownerId) return interaction.reply({ content: "❌ Invalid VC button", ephemeral: true });

const member = await interaction.guild.members.fetch(interaction.user.id);
const isOwner = interaction.user.id === ownerId;
const isAdmin = member.permissions.has(PermissionsBitField.Flags.ManageChannels);

if (!isOwner && !isAdmin) {
  return interaction.reply({
    content: "❌ You don’t own this VC or have permission to manage it.",
    ephemeral: true,
  });
}

        const vch = getVChData();
        const entry = vch[ownerId];
        if (!entry) return interaction.reply({ content: "❌ VC record not found.", ephemeral: true });

        const guild = interaction.guild;
        let voiceChannel = null;
        try {
          if (entry.voiceChannelId) voiceChannel = await guild.channels.fetch(entry.voiceChannelId).catch(() => null);
        } catch (e) {
          voiceChannel = null;
        }

        if (action === "lock") {
          if (!voiceChannel) return interaction.reply({ content: "❌ Voice channel not found.", ephemeral: true });
          try {
            await voiceChannel.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: false });
            return interaction.reply({ content: "🔒 Channel locked!", ephemeral: true });
          } catch (e) {
            console.error("vc lock error", e);
            return interaction.reply({ content: "❌ Failed to lock channel.", ephemeral: true });
          }
        }

        if (action === "unlock") {
          if (!voiceChannel) return interaction.reply({ content: "❌ Voice channel not found.", ephemeral: true });
          try {
            await voiceChannel.permissionOverwrites.edit(interaction.guild.roles.everyone, { Connect: true });
            return interaction.reply({ content: "🔓 Channel unlocked!", ephemeral: true });
          } catch (e) {
            console.error("vc unlock error", e);
            return interaction.reply({ content: "❌ Failed to unlock channel.", ephemeral: true });
          }
        }

        if (action === "rename") {
          const modal = new ModalBuilder().setCustomId(`vc_rename_modal_${ownerId}`).setTitle("Rename your VC");
          const input = new TextInputBuilder().setCustomId("vc_new_name").setLabel("New channel name").setStyle(TextInputStyle.Short).setRequired(true);
          modal.addComponents(new ActionRowBuilder().addComponents(input));
          return interaction.showModal(modal);
        }
        if (action === "invite") {
          const modal = new ModalBuilder().setCustomId(`vc_invite_modal_${ownerId}`).setTitle("Invite to your VC");
          const input = new TextInputBuilder().setCustomId("vc_invite_user").setLabel("User ID or @mention").setStyle(TextInputStyle.Short).setRequired(true);
          modal.addComponents(new ActionRowBuilder().addComponents(input));
          return interaction.showModal(modal);
        }
if (action === "delete") {
  try {
    await interaction.reply({
      content: "🗑️ Deleting your VC and controller...",
      ephemeral: true,
    });

    // Delete the voice channel
    if (voiceChannel) await voiceChannel.delete().catch(() => {});

    // Delete the per-user controller text channel (NOT the permanent hub)
    if (entry.controlChannelId && entry.controlChannelId !== VOICE_MENU_CHANNEL_ID) {
      const controlChannel = await guild.channels.fetch(entry.controlChannelId).catch(() => null);
      if (controlChannel) await controlChannel.delete().catch(() => {});
    }

    // Clean up record
    delete vch[ownerId];
    saveVChData(vch);

    // Ensure the original interaction reply is not edited if already deleted
    if (!interaction.replied) {
      await interaction.editReply({
        content: "🗑️ Your voice channel and controller have been deleted. You can create a new one anytime with the **Create VC** button.",
      }).catch(() => {});
    }
  } catch (e) {
    console.error("vc delete error", e);
    if (!interaction.replied) {
      await interaction.reply({
        content: "❌ Failed to delete VC and controller.",
        ephemeral: true,
      }).catch(() => {});
    }
  }
}

      }
    }
  } catch (err) {
    console.error("interactionCreate error:", err);
    try {
      if (interaction && !interaction.replied && !interaction.deferred) {
        interaction.reply({ content: "⚠️ Internal error occurred.", ephemeral: true }).catch(() => {});
      }
    } catch {}
  }
});

/* --------------------------
   Register slash commands (poll removed)
   -------------------------- */
const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
async function registerCommands() {
  const commands = [
    { name: "verify", description: "Verify your Twitch subscription to get the role" },
    { name: "rank", description: "Check your XP and Level" },
    { name: "leaderboard", description: "Show the top XP earners" },
    {
      name: "clear",
      description: "Bulk delete messages in this channel",
      options: [
        {
          name: "amount",
          description: "Number of messages to delete",
          type: 4, // INTEGER
          required: false,
        },
      ],
    },
    {
      name: "rsocial",
      description: "Admin: Refresh and post socials message",
    },
    {
      name: "guidelines",
      description: "Admin: Post the guidelines page",
    },
  ];
  try {
    await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, GUILD_ID), { body: commands });
    console.log("✅ Slash commands registered.");
  } catch (err) {
    console.error("registerCommands error:", err);
  }
}

registerCommands().catch((e) => console.error(e));
client.login(DISCORD_TOKEN).catch((e) => console.error("login error", e));

async function postGuidelinesMessage() {
  if (!GUIDELINES_CHANNEL_ID) return;
  const channel = await client.channels.fetch(GUIDELINES_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) return;
  const imageUrl = process.env.GUIDELINES_IMAGE_URL || "https://yt3.googleusercontent.com/BCsEyurnU4RQJXRzpQAe109tL_u9uUP0cHmQIqahxMr-JT65iI-AbB2WSzsidHuaztQIKuEsuA=s160-c-k-c0x00ffffff-no-rj";
  const embed = new EmbedBuilder()
    .setColor(0x9b59b6) // purple
    .setTitle("Guidelines @ 2Hundy Gang")
    .setImage(imageUrl)
    .addFields(
      { name: "1 | Discord Terms of Service", value: "We as a community follow the Discord Terms of Service & Community Guidelines, failure to do so yourself will result in moderation such as a potential removal from the server." },
      { name: "2 | Discrimination", value: "Discrimination of any kind will not be tolerated, we are strictly against any forms of racism, sexism or prejudice behaviour towards any individual." },
      { name: "3 | Under 13", value: "Any individuals under the age of 13 will be removed from the server as per Discord Terms of Service." },
      { name: "4 | Spamming & Mass Mentioning", value: "Any spamming or mass mentioning of other users or moderation & administration will result in a timeout 1 hour, if continued you will be kicked from the server." },
      { name: "5 | NSFW & Obscene Content", value: "Content that depicts gore, sexual & explicit content will result in a permananent ban from the community, we'll also enforce any sexually motivated messages." },
      { name: "6 | Support", value: "Support can be contacted via our tickets system, however, only contact support if it is absolutely vital or if you are trying to report a member of the server for a violation of our guidelines and a member of staff hadn't been in chat at the time." },
      { name: "🛡️ Moderator's Discretion", value: "Moderator's have authorisation to moderate users on their ultimate say on a per case basis, however if you believe you were unfairly moderated, contact the Head of Moderation or an Administrator." }
    )
    .setFooter({ text: "2Hundy Gang" })
    .setTimestamp();

  const message = await channel.send({ embeds: [embed] });
  await message.react("✅");

  client.on("messageReactionAdd", async (reaction, user) => {
    if (reaction.partial) {
      try {
        await reaction.fetch();
      } catch (error) {
        console.error("Failed to fetch reaction:", error);
        return;
      }
    }

    if (reaction.message.channel.id === GUIDELINES_CHANNEL_ID && reaction.emoji.name === "✅") {
      const guild = reaction.message.guild;
      const member = await guild.members.fetch(user.id).catch(() => null);
      if (!member) {
        console.error("Member not found for user ID:", user.id);
        return;
      }

      const role = guild.roles.cache.find(r => r.name === "Not a Waste Man");
      if (!role) {
        console.error("Role 'Not a Waste Man' not found in the guild.");
        return;
      }

      if (member.roles.cache.has(role.id)) {
        console.log(`Member ${user.id} already has the role.`);
        return;
      }

      try {
        await member.roles.add(role);
        console.log(`Role 'Not a Waste Man' successfully added to member ${user.id}.`);
      } catch (error) {
        console.error("Failed to add role to member:", error);
      }
    }
  });
}

// Post Twitch live info in 'life' channel
async function postLiveInfo() {
  const live = await isTwitchLive();
  const channel = await client.channels.fetch(process.env.LIFE_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) return;
  if (live) {
    await channel.send({ content: `🔴 **J2hundred is LIVE on Twitch!**\nTitle: ${live.title}\nWatch: https://www.twitch.tv/J2hundred` });
  } else {
    await channel.send({ content: `⚪️ J2hundred is currently offline on Twitch.` });
  }
}

// Post latest YouTube video in 'youtube' channel
async function postYouTubeVideo() {
  const video = await getLatestYouTubeVideo();
  const channel = await client.channels.fetch(process.env.YOUTUBE_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased() || !video) return;
  await channel.send({ content: `▶️ **Latest YouTube Video:** [${video.title}](${video.url})`, embeds: [
    new EmbedBuilder().setTitle(video.title).setURL(video.url).setImage(video.thumbnail)
  ] });
}

// Roles embed and reaction role logic
async function postRolesEmbed() {
  const channel = await client.channels.fetch(ROLES_MENU_CHANNEL_ID).catch(() => null);
  if (!channel || !channel.isTextBased()) return;
  // Check if a roles embed already exists in the last 20 messages
  const recent = await channel.messages.fetch({ limit: 20 });
  const found = recent.find(m => m.author.id === client.user.id && m.embeds?.length && m.embeds[0].title === 'Choose Your Roles!');
  if (found) return;
  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('Choose Your Roles!')
    .setDescription(`React to get or remove roles:\n\n:video_game: - Games Area\n:mega: - Video Drop Pings\n⭐ - Notified Pings`)
    .setFooter({ text: '2Hundy Gang Roles' })
    .setTimestamp();
  const msg = await channel.send({ embeds: [embed] });
  await msg.react('🎮');
  await msg.react('📢');
  await msg.react('⭐');
}

client.on('messageReactionAdd', async (reaction, user) => {
  if (reaction.message.channel.id !== ROLES_MENU_CHANNEL_ID) return;
  const guild = reaction.message.guild;
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) return;
  let roleId;
  if (reaction.emoji.name === '🎮') roleId = ROLE_GAMES_ID;
  if (reaction.emoji.name === '📢') roleId = ROLE_VIDEO_ID;
  if (reaction.emoji.name === '⭐') roleId = ROLE_NOTIFY_ID;
  if (roleId && !member.roles.cache.has(roleId)) {
    await member.roles.add(roleId).catch(() => {});
  }
});

client.on('messageReactionRemove', async (reaction, user) => {
  if (reaction.message.channel.id !== ROLES_MENU_CHANNEL_ID) return;
  const guild = reaction.message.guild;
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) return;
  let roleId;
  if (reaction.emoji.name === '🎮') roleId = ROLE_GAMES_ID;
  if (reaction.emoji.name === '📢') roleId = ROLE_VIDEO_ID;
  if (reaction.emoji.name === '⭐') roleId = ROLE_NOTIFY_ID;
  if (roleId && member.roles.cache.has(roleId)) {
    await member.roles.remove(roleId).catch(() => {});
  }
});

const ENSEMBLE_API_ROOT = "https://ensembledata.com/apis";
const ENSEMBLE_API_TOKEN = process.env.ENSEMBLE_API_TOKEN;

async function checkTwitchFollowerViaEnsemble(username) {
  try {
    const endpoint = "/twitch/user/followers";
    const params = new URLSearchParams({ username, token: ENSEMBLE_API_TOKEN });
    const url = `${ENSEMBLE_API_ROOT}${endpoint}?${params}`;
    const res = await fetch(url);
    const data = await res.json();
    return data; // structure depends on API response
  } catch (e) {
    console.error("Ensemble Twitch follower API error", e);
    return null;
  }
}
// Example usage in verify command:
// const followerData = await checkTwitchFollowerViaEnsemble(userData.twitchName);
// if (followerData && followerData.isFollower) { /* grant role */ }
