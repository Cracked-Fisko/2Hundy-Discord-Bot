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

async function isTwitchSub(userId) {
  try {
    const tokenData = await getTwitchToken();
    const res = await fetch(
      `https://api.twitch.tv/helix/subscriptions?broadcaster_id=${TWITCH_BROADCASTER_ID}&user_id=${userId}`,
      {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
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
    const uploadsPlaylist =
      channelData.items[0].contentDetails.relatedPlaylists.uploads;

    const playlistRes = await fetch(
      `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=1&playlistId=${uploadsPlaylist}&key=${YOUTUBE_API_KEY}`
    );
    const playlistData = await playlistRes.json();
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
client.on("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // send socials links on ready (once)
  try {
    const channel = await client.channels.fetch(Socials_MENU_CHANNEL_ID).catch(() => null);
    if (channel && channel.isTextBased()) {
      const socials = [
        { name: "Twitch", url: `https://twitch.tv/${TW_Chn}` },
        { name: "YouTube", url: `https://www.youtube.com/channel/${YOUTUBE_CHANNEL_ID}` },
      ];
      await channel.send({ content: socials.map((s) => `🔗 **${s.name}:** ${s.url}`).join("\n") });
    }
  } catch (e) {
    console.error("Failed posting socials on ready:", e);
  }

  // Post ticket menu
  sendTicketMenu().catch((e) => console.error("sendTicketMenu error:", e));

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

    const content = (message.content || "").toLowerCase();
    const hasLink = /(https?:\/\/[^\s]+)/.test(content);
    const hasAttachment = message.attachments.size > 0;
    const hasBannedWord = bannedWords.some((w) => w && content.includes(w));

    if (hasLink || hasAttachment || hasBannedWord) {
      // moderation
      const userId = message.author.id;
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
        console.error("Failed to fetch member:", err);
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
        console.error("Moderation action failed:", err);
        await message.channel.send(`⚠️ Error applying moderation to <@${userId}>. Check bot permissions.`);
      }

      // do NOT award XP for violating messages
      return;
    }

    // ---- XP awarding (non-violating messages) ----
    try {
      const xpData = getXPData();
      const userId = message.author.id;
      if (!xpData[userId]) xpData[userId] = { xp: 0, level: 0 };

      // Add 0.05 XP per message
      xpData[userId].xp += 0.05;

      // Level up logic: every 200 XP = level 1; formula uses (level+1)*200
      const neededXP = (xpData[userId].level + 1) * 200;
      if (xpData[userId].xp >= neededXP) {
        xpData[userId].level += 1;
        await message.channel.send(`🎉 Congrats <@${userId}>, you reached **Level ${xpData[userId].level}!**`);

        // NOTE: we removed automatic VC creation on level-up.
        // Users must click the permanent "Create VC" button in the VC hub,
        // which will enforce they are level >= 1 before creating.
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
      if (interaction.commandName === "verify") {
        const verifiedUsers = getVerifiedUsers();
        const userData = verifiedUsers[interaction.user.id];
        if (!userData || !userData.twitchName) {
          const url = `${OAUTH_BASE_URL}/authorize?discordId=${interaction.user.id}`;
          return interaction.reply({ content: `Click here to link your Twitch account: ${url}`, ephemeral: true });
        }

        // Keep verification flow (unchanged) — attempt subscription check
        try {
          const tokenData = await getTwitchToken();
          const userRes = await fetch(`https://api.twitch.tv/helix/users?id=${userData.twitchId}`, {
            headers: { "Client-Id": TWITCH_CLIENT_ID, Authorization: `Bearer ${tokenData.access_token}` },
          });
          const userJson = await userRes.json();
          if (!userJson.data || userJson.data.length === 0)
            return interaction.reply({ content: "❌ Could not find Twitch account.", ephemeral: true });

          const twitchUserId = userJson.data[0].id;

          const subRes = await fetch(
            `https://api.twitch.tv/helix/subscriptions?broadcaster_id=${TWITCH_BROADCASTER_ID}&user_id=${twitchUserId}`,
            { headers: { "Client-Id": TWITCH_CLIENT_ID, Authorization: `Bearer ${tokenData.access_token}` } }
          );
          const subData = await subRes.json();

          if (!subData.data || subData.data.length === 0)
            return interaction.reply({ content: "❌ You are not subscribed to the Twitch channel.", ephemeral: true });

          // Add role (DISCORD_ROLE_NAME should be the role ID in your .env)
          const member = await interaction.guild.members.fetch(interaction.user.id);
          const role = interaction.guild.roles.cache.get(DISCORD_ROLE_NAME);
          if (role && !member.roles.cache.has(role.id)) await member.roles.add(role);

          return interaction.reply({ content: `✅ Verified! Role added.`, ephemeral: true });
        } catch (e) {
          console.error("verify command error:", e);
          return interaction.reply({ content: "❌ Verification failed (internal error).", ephemeral: true });
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
if (action === "delete") {
  try {
    await interaction.reply({
      content: "🗑️ Deleting your VC and controller...",
      ephemeral: true,
    });
await interaction.followUp({
  content: "🗑️ Your voice channel and controller have been deleted. You can create a new one anytime with the **Create VC** button.",
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

    await interaction.editReply({
      content: "🗑️ Your voice channel and controller have been deleted. You can create a new one anytime with the **Create VC** button.",
    });
  } catch (e) {
    console.error("vc delete error", e);
    if (!interaction.replied) {
      await interaction.reply({
        content: "❌ Failed to delete VC and controller.",
        ephemeral: true,
      });
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
