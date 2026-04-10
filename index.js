const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  InteractionType,
} = require('discord.js');

dotenv.config();

const TOKEN = process.env.DISCORD_TOKEN;
const SVS_CHANNEL_ID = process.env.SVS_CHANNEL_ID;
const RALLY_MANAGER_ROLE_NAME =
  process.env.RALLY_MANAGER_ROLE_NAME || 'Rally Lead';
const DATA_DIR = process.env.DATA_DIR || __dirname;

if (!TOKEN || !SVS_CHANNEL_ID) {
  console.error('Missing required environment variables.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const sessions = new Map();

const leadsPath = path.join(DATA_DIR, 'rally_leads.json');
const groupsPath = path.join(DATA_DIR, 'rally_groups.json');
const dashboardStatePath = path.join(DATA_DIR, 'dashboard_state.json');

const GROUP_NAMES = [
  'ST8 Rally 1',
  'ST8 Rally 2',
  'ST2 Rally 1',
  'ST2 Rally 2',
];

let leads = [];
let groups = [];
let dashboardMessageId = null;
let refreshInFlight = false;
let lastDashboardHash = '';

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function ensureJsonFile(filePath, defaultValue) {
  ensureDataDir();
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2), 'utf8');
  }
}

function readJson(filePath, fallback) {
  try {
    ensureJsonFile(filePath, fallback);
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    console.error(`Failed to read ${filePath}`, error);
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureJsonFile(filePath, value);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function loadLeadsFromDisk() {
  return readJson(leadsPath, []);
}

function saveLeadsToDisk() {
  writeJson(leadsPath, leads);
}

function loadGroupsFromDisk() {
  const defaultGroups = GROUP_NAMES.map((name) => ({
    name,
    leadUserIds: [],
    lastArrivalTime: null,
    lastCalculatedAt: null,
  }));

  const loaded = readJson(groupsPath, defaultGroups);
  const existingNames = new Set(loaded.map((g) => g.name));
  let changed = false;

  for (const groupName of GROUP_NAMES) {
    if (!existingNames.has(groupName)) {
      loaded.push({
        name: groupName,
        leadUserIds: [],
        lastArrivalTime: null,
        lastCalculatedAt: null,
      });
      changed = true;
    }
  }

  for (const group of loaded) {
    if (!Object.prototype.hasOwnProperty.call(group, 'lastArrivalTime')) {
      group.lastArrivalTime = null;
      changed = true;
    }
    if (!Object.prototype.hasOwnProperty.call(group, 'lastCalculatedAt')) {
      group.lastCalculatedAt = null;
      changed = true;
    }
  }

  if (changed) {
    writeJson(groupsPath, loaded);
  }

  return loaded;
}

function saveGroupsToDisk() {
  writeJson(groupsPath, groups);
}

function loadDashboardState() {
  const state = readJson(dashboardStatePath, { dashboardMessageId: null });
  dashboardMessageId = state.dashboardMessageId || null;
}

function saveDashboardState() {
  writeJson(dashboardStatePath, { dashboardMessageId });
}

function hasManagerAccess(member) {
  return member?.roles?.cache?.some(
    (role) => role.name === RALLY_MANAGER_ROLE_NAME
  );
}

function formatUtcTime(date) {
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss} UTC`;
}

function formatCountdownMs(ms) {
  const safeMs = Math.max(0, ms);
  const totalSeconds = Math.ceil(safeMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(
    2,
    '0'
  )}`;
}

function formatCountdownToDate(date) {
  return formatCountdownMs(date.getTime() - Date.now());
}

function roundUpToNext15Seconds(date) {
  const rounded = new Date(date.getTime());
  rounded.setUTCMilliseconds(0);

  const seconds = rounded.getUTCSeconds();
  const remainder = seconds % 15;

  if (remainder === 0) {
    return rounded;
  }

  rounded.setUTCSeconds(seconds + (15 - remainder));
  return rounded;
}

function getTotalTravelSeconds(lead) {
  return 300 + Number(lead.rallySeconds || 0);
}

function upsertLeadInMemory({ userId, discordName, gameName, rallySeconds }) {
  const existing = leads.find((l) => l.userId === userId);

  if (existing) {
    existing.discordName = discordName;
    existing.gameName = gameName;
    existing.rallySeconds = rallySeconds;
    existing.source = 'self';
    existing.updatedAt = new Date().toISOString();
  } else {
    leads.push({
      userId,
      discordName,
      gameName,
      rallySeconds,
      source: 'self',
      manualId: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  saveLeadsToDisk();
}

function upsertManualLeadInMemory({ gameName, rallySeconds, discordUserId }) {
  const normalizedGameName = gameName.trim().toLowerCase();

  const existing = leads.find(
    (l) =>
      (discordUserId && l.userId && l.userId === discordUserId) ||
      l.gameName.trim().toLowerCase() === normalizedGameName
  );

  if (existing) {
    existing.userId = discordUserId || existing.userId || null;
    existing.gameName = gameName;
    existing.rallySeconds = rallySeconds;
    existing.source = 'manual';
    existing.updatedAt = new Date().toISOString();
  } else {
    leads.push({
      userId: discordUserId || null,
      discordName: null,
      gameName,
      rallySeconds,
      source: 'manual',
      manualId: `manual_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 6)}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  saveLeadsToDisk();
}

function buildDashboardDescription() {
  const now = Date.now();

  const leadText =
    leads.length === 0
      ? 'No rally leads registered yet.'
      : leads
          .slice(0, 15)
          .map((lead, i) => {
            const mention = lead.userId ? ` - <@${lead.userId}>` : '';
            const source = lead.source === 'manual' ? ' [manual]' : '';
            return `**${i + 1}. ${lead.gameName}** - ${lead.rallySeconds}s${mention}${source}`;
          })
          .join('\n');

  const groupText = groups
    .map((group) => {
      const members =
        group.leadUserIds.length === 0
          ? 'None'
          : group.leadUserIds
              .map((id) => {
                const lead = leads.find((l) => l.userId === id || l.manualId === id);
                return lead ? `${lead.gameName}` : id;
              })
              .join(', ');

      let suffix = '';
      if (group.lastArrivalTime) {
        const landDate = new Date(group.lastArrivalTime);
        if (!Number.isNaN(landDate.getTime()) && landDate.getTime() > now) {
          suffix = ` | Land: ${formatUtcTime(
            landDate
          )} | ${formatCountdownToDate(landDate)}`;
        } else if (!Number.isNaN(landDate.getTime())) {
          suffix = ` | Land: ${formatUtcTime(landDate)} | 00:00`;
        }
      }

      return `**${group.name}**: ${members}${suffix}`;
    })
    .join('\n');

  return [`**Rally Leads**`, leadText, '', `**Groups**`, groupText].join('\n');
}

function buildDashboardRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('lead:register')
        .setLabel('Become Rally Lead')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('lead:add_manual')
        .setLabel('Add Rally Lead')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('dashboard:refresh')
        .setLabel('Refresh Dashboard')
        .setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('group:assign')
        .setLabel('Assign Lead To Group')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('group:calculate')
        .setLabel('Calculate Launch Times')
        .setStyle(ButtonStyle.Primary)
    ),
  ];
}

function buildGroupSelect(customId) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder('Select a group')
      .addOptions(
        GROUP_NAMES.map((name) => ({
          label: name,
          value: name,
        }))
      )
  );
}

function buildLeadSelect(customId) {
  if (leads.length === 0) {
    return null;
  }

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder('Select a rally lead')
      .addOptions(
        leads.slice(0, 25).map((lead) => ({
          label: `${lead.gameName} (${lead.rallySeconds}s)`.slice(0, 100),
          value: lead.userId || lead.manualId,
          description: (
            lead.discordName ||
            (lead.userId ? `User ${lead.userId}` : 'Manual lead')
          ).slice(0, 100),
        }))
      )
  );
}

function buildLaunchOffsetSelect() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('group:calculate_select_offset')
      .setPlaceholder('Select launch offset')
      .addOptions(
        { label: '15 seconds from now', value: '15' },
        { label: '30 seconds from now', value: '30' },
        { label: '45 seconds from now', value: '45' },
        { label: '60 seconds from now', value: '60' }
      )
  );
}

function buildLaunchPlanFromOffsetEmbed(
  groupName,
  offsetSeconds,
  longestLaunchTime,
  arrivalTime,
  selectedLeads
) {
  const lines = selectedLeads
    .map((lead) => {
      const launchTime = new Date(
        arrivalTime.getTime() - getTotalTravelSeconds(lead) * 1000
      );

      return `${lead.gameName} - ${formatUtcTime(launchTime)} (${formatCountdownToDate(
        launchTime
      )})`;
    })
    .join('\n');

  return new EmbedBuilder()
    .setTitle(`${groupName} Launch Plan`)
    .setDescription(
      [
        `Longest rally starts in **${offsetSeconds}s**`,
        `Longest launch: ${formatUtcTime(longestLaunchTime)} (${formatCountdownToDate(
          longestLaunchTime
        )})`,
        `Land time: ${formatUtcTime(arrivalTime)} (${formatCountdownToDate(
          arrivalTime
        )})`,
        '',
        lines,
      ].join('\n')
    );
}

async function refreshDashboardMessage(force = false) {
  if (refreshInFlight) return;
  refreshInFlight = true;

  try {
    const channel = await client.channels.fetch(SVS_CHANNEL_ID);

    if (!channel || !channel.isTextBased()) {
      console.error('SVS channel is not text-based or not found.');
      return;
    }

    const description = buildDashboardDescription();
    const nextHash = JSON.stringify({
      description,
      dashboardMessageId,
    });

    if (!force && dashboardMessageId && nextHash === lastDashboardHash) {
      return;
    }

    const payload = {
      embeds: [
        new EmbedBuilder()
          .setTitle('SvS Rally Lead Dashboard')
          .setDescription(description),
      ],
      components: buildDashboardRows(),
    };

    let msg = null;

    if (dashboardMessageId) {
      try {
        msg = await channel.messages.fetch(dashboardMessageId);
      } catch (error) {
        msg = null;
      }
    }

    if (msg) {
      await msg.edit(payload);
    } else {
      const sent = await channel.send(payload);
      dashboardMessageId = sent.id;
      saveDashboardState();
    }

    lastDashboardHash = nextHash;
  } catch (error) {
    console.error('Failed to refresh dashboard message', error);
  } finally {
    refreshInFlight = false;
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  ensureJsonFile(leadsPath, []);
  ensureJsonFile(
    groupsPath,
    GROUP_NAMES.map((name) => ({
      name,
      leadUserIds: [],
      lastArrivalTime: null,
      lastCalculatedAt: null,
    }))
  );
  ensureJsonFile(dashboardStatePath, { dashboardMessageId: null });

  leads = loadLeadsFromDisk();
  groups = loadGroupsFromDisk();
  loadDashboardState();

  await refreshDashboardMessage(true);

  setInterval(() => {
    refreshDashboardMessage(false).catch((error) =>
      console.error('Failed to refresh dashboard on interval', error)
    );
  }, 1000);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton()) {
      if (interaction.customId === 'lead:register') {
        const modal = new ModalBuilder()
          .setCustomId('lead:register_modal')
          .setTitle('Become Rally Lead');

        const gameNameInput = new TextInputBuilder()
          .setCustomId('game_name')
          .setLabel('Game Name')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder('Seph');

        const rallySecondsInput = new TextInputBuilder()
          .setCustomId('rally_seconds')
          .setLabel('Rally Time (seconds)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder('30');

        modal.addComponents(
          new ActionRowBuilder().addComponents(gameNameInput),
          new ActionRowBuilder().addComponents(rallySecondsInput)
        );

        await interaction.showModal(modal);
        return;
      }

      if (interaction.customId === 'lead:add_manual') {
        if (!hasManagerAccess(interaction.member)) {
          await interaction.reply({
            content: `You need the **${RALLY_MANAGER_ROLE_NAME}** role to use this.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const modal = new ModalBuilder()
          .setCustomId('lead:add_manual_modal')
          .setTitle('Add Rally Lead');

        const gameNameInput = new TextInputBuilder()
          .setCustomId('game_name')
          .setLabel('Game Name')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder('UNb');

        const rallySecondsInput = new TextInputBuilder()
          .setCustomId('rally_seconds')
          .setLabel('Rally Time (seconds)')
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setPlaceholder('40');

        const discordIdInput = new TextInputBuilder()
          .setCustomId('discord_user_id')
          .setLabel('Discord User ID (optional)')
          .setStyle(TextInputStyle.Short)
          .setRequired(false)
          .setPlaceholder('123456789012345678');

        modal.addComponents(
          new ActionRowBuilder().addComponents(gameNameInput),
          new ActionRowBuilder().addComponents(rallySecondsInput),
          new ActionRowBuilder().addComponents(discordIdInput)
        );

        await interaction.showModal(modal);
        return;
      }

      if (interaction.customId === 'dashboard:refresh') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await refreshDashboardMessage(true);
        await interaction.editReply({
          content: 'Dashboard refreshed.',
        });
        return;
      }

      if (
        interaction.customId === 'group:assign' ||
        interaction.customId === 'group:calculate'
      ) {
        if (!hasManagerAccess(interaction.member)) {
          await interaction.reply({
            content: `You need the **${RALLY_MANAGER_ROLE_NAME}** role to use this.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (interaction.customId === 'group:assign') {
          sessions.set(interaction.user.id, { flow: 'assign_group' });

          await interaction.reply({
            content: 'Select a group.',
            components: [buildGroupSelect('group:assign_select_group')],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (interaction.customId === 'group:calculate') {
          sessions.set(interaction.user.id, { flow: 'calculate_group' });

          await interaction.reply({
            content: 'Select a group to calculate.',
            components: [buildGroupSelect('group:calculate_select_group')],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
      }
    }

    if (interaction.isStringSelectMenu()) {
      if (
        interaction.customId === 'group:assign_select_group' ||
        interaction.customId === 'group:calculate_select_group' ||
        interaction.customId === 'group:assign_select_lead' ||
        interaction.customId === 'group:calculate_select_offset'
      ) {
        if (!hasManagerAccess(interaction.member)) {
          await interaction.reply({
            content: `You need the **${RALLY_MANAGER_ROLE_NAME}** role to use this.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
      }

      if (interaction.customId === 'group:assign_select_group') {
        const groupName = interaction.values[0];
        const session = sessions.get(interaction.user.id) || {};
        session.groupName = groupName;
        sessions.set(interaction.user.id, session);

        const leadSelect = buildLeadSelect('group:assign_select_lead');
        if (!leadSelect) {
          await interaction.update({
            content: 'No rally leads are registered yet.',
            components: [],
          });
          return;
        }

        await interaction.update({
          content: `Selected **${groupName}**. Now select a rally lead.`,
          components: [leadSelect],
        });
        return;
      }

      if (interaction.customId === 'group:assign_select_lead') {
        await interaction.deferUpdate();

        const selectedLeadId = interaction.values[0];
        const session = sessions.get(interaction.user.id);

        if (!session?.groupName) {
          await interaction.followUp({
            content: 'Your session expired. Please start again.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        for (const group of groups) {
          group.leadUserIds = group.leadUserIds.filter(
            (id) => id !== selectedLeadId
          );
        }

        const targetGroup = groups.find((g) => g.name === session.groupName);
        if (!targetGroup) {
          await interaction.followUp({
            content: 'Group not found.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (!targetGroup.leadUserIds.includes(selectedLeadId)) {
          targetGroup.leadUserIds.push(selectedLeadId);
        }

        saveGroupsToDisk();
        sessions.delete(interaction.user.id);
        await refreshDashboardMessage(true);

        const lead = leads.find(
          (l) => l.userId === selectedLeadId || l.manualId === selectedLeadId
        );

        await interaction.followUp({
          content: `Assigned **${lead?.gameName || selectedLeadId}** to **${targetGroup.name}**.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.customId === 'group:calculate_select_group') {
        const groupName = interaction.values[0];
        const session = sessions.get(interaction.user.id) || {};
        session.groupName = groupName;
        sessions.set(interaction.user.id, session);

        await interaction.update({
          content: `Selected **${groupName}**. Now choose when the longest rally should launch.`,
          components: [buildLaunchOffsetSelect()],
        });
        return;
      }

      if (interaction.customId === 'group:calculate_select_offset') {
        await interaction.deferUpdate();

        const session = sessions.get(interaction.user.id);
        if (!session?.groupName) {
          await interaction.followUp({
            content: 'Your session expired. Please start again.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const offsetSeconds = Number(interaction.values[0]);
        const group = groups.find((g) => g.name === session.groupName);

        if (!group) {
          await interaction.followUp({
            content: 'Group not found.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const groupLeads = group.leadUserIds
          .map((id) =>
            leads.find((lead) => lead.userId === id || lead.manualId === id)
          )
          .filter(Boolean);

        if (groupLeads.length === 0) {
          await interaction.followUp({
            content: 'That group has no rally leads assigned.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const maxTravelSeconds = Math.max(
          ...groupLeads.map((lead) => getTotalTravelSeconds(lead))
        );

        const now = new Date();
        const rawLongestLaunchTime = new Date(
          now.getTime() + offsetSeconds * 1000
        );

        const longestLaunchTime = roundUpToNext15Seconds(rawLongestLaunchTime);

        const arrivalTime = new Date(
          longestLaunchTime.getTime() + maxTravelSeconds * 1000
        );

        group.lastArrivalTime = arrivalTime.toISOString();
        group.lastCalculatedAt = new Date().toISOString();
        saveGroupsToDisk();

        const channel = await client.channels.fetch(SVS_CHANNEL_ID);
        if (!channel || !channel.isTextBased()) {
          await interaction.followUp({
            content: 'SvS channel is not available.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        await channel.send({
          embeds: [
            buildLaunchPlanFromOffsetEmbed(
              group.name,
              offsetSeconds,
              longestLaunchTime,
              arrivalTime,
              groupLeads
            ),
          ],
        });

        sessions.delete(interaction.user.id);
        await refreshDashboardMessage(true);

        await interaction.followUp({
          content: `Launch plan posted for **${group.name}**.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    if (interaction.type === InteractionType.ModalSubmit) {
      if (interaction.customId === 'lead:register_modal') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const gameName = interaction.fields.getTextInputValue('game_name').trim();
        const rallySeconds = Number(
          interaction.fields.getTextInputValue('rally_seconds').trim()
        );

        if (!gameName) {
          await interaction.editReply({
            content: 'Game Name is required.',
          });
          return;
        }

        if (!Number.isFinite(rallySeconds) || rallySeconds <= 0) {
          await interaction.editReply({
            content: 'Rally Time must be a valid number greater than 0.',
          });
          return;
        }

        upsertLeadInMemory({
          userId: interaction.user.id,
          discordName: interaction.member?.displayName || interaction.user.username,
          gameName,
          rallySeconds,
        });

        await refreshDashboardMessage(true);

        await interaction.editReply({
          content: `Registered **${gameName}** with rally time **${rallySeconds}s**.`,
        });
        return;
      }

      if (interaction.customId === 'lead:add_manual_modal') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        if (!hasManagerAccess(interaction.member)) {
          await interaction.editReply({
            content: `You need the **${RALLY_MANAGER_ROLE_NAME}** role to use this.`,
          });
          return;
        }

        const gameName = interaction.fields.getTextInputValue('game_name').trim();
        const rallySeconds = Number(
          interaction.fields.getTextInputValue('rally_seconds').trim()
        );
        const discordUserId = interaction.fields
          .getTextInputValue('discord_user_id')
          .trim();

        if (!gameName) {
          await interaction.editReply({
            content: 'Game Name is required.',
          });
          return;
        }

        if (!Number.isFinite(rallySeconds) || rallySeconds <= 0) {
          await interaction.editReply({
            content: 'Rally Time must be a valid number greater than 0.',
          });
          return;
        }

        const safeDiscordUserId = discordUserId || null;

        upsertManualLeadInMemory({
          gameName,
          rallySeconds,
          discordUserId: safeDiscordUserId,
        });

        await refreshDashboardMessage(true);

        await interaction.editReply({
          content: `Added rally lead **${gameName}** with rally time **${rallySeconds}s**.`,
        });
        return;
      }
    }
  } catch (error) {
    console.error('Interaction error', error);

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({
        content: 'Something went wrong.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => null);
    } else {
      await interaction.reply({
        content: 'Something went wrong.',
        flags: MessageFlags.Ephemeral,
      }).catch(() => null);
    }
  }
});

client.login(TOKEN);
