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

const GROUP_NAMES = [
  'ST8 Rally 1',
  'ST8 Rally 2',
  'ST2 Rally 1',
  'ST2 Rally 2',
];

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

function loadLeads() {
  return readJson(leadsPath, []);
}

function saveLeads(leads) {
  writeJson(leadsPath, leads);
}

function loadGroups() {
  const defaultGroups = GROUP_NAMES.map((name) => ({
    name,
    leadUserIds: [],
  }));
  const groups = readJson(groupsPath, defaultGroups);

  const existingNames = new Set(groups.map((g) => g.name));
  let changed = false;

  for (const groupName of GROUP_NAMES) {
    if (!existingNames.has(groupName)) {
      groups.push({ name: groupName, leadUserIds: [] });
      changed = true;
    }
  }

  if (changed) saveGroups(groups);
  return groups;
}

function saveGroups(groups) {
  writeJson(groupsPath, groups);
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

function upsertLead({ userId, discordName, gameName, rallySeconds }) {
  const leads = loadLeads();
  const existing = leads.find((l) => l.userId === userId);

  if (existing) {
    existing.discordName = discordName;
    existing.gameName = gameName;
    existing.rallySeconds = rallySeconds;
    existing.updatedAt = new Date().toISOString();
  } else {
    leads.push({
      userId,
      discordName,
      gameName,
      rallySeconds,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  saveLeads(leads);
}

function buildDashboardEmbed() {
  const leads = loadLeads();
  const groups = loadGroups();

  const leadText =
    leads.length === 0
      ? 'No rally leads registered yet.'
      : leads
          .slice(0, 15)
          .map(
            (lead, i) =>
              `**${i + 1}. ${lead.gameName}** - ${lead.rallySeconds}s - <@${lead.userId}>`
          )
          .join('\n');

  const groupText = groups
    .map((group) => {
      const members =
        group.leadUserIds.length === 0
          ? 'None'
          : group.leadUserIds
              .map((id) => {
                const lead = leads.find((l) => l.userId === id);
                return lead ? `${lead.gameName}` : `<@${id}>`;
              })
              .join(', ');

      return `**${group.name}**: ${members}`;
    })
    .join('\n');

  return new EmbedBuilder()
    .setTitle('SvS Rally Lead Dashboard')
    .setDescription(
      [
        `**Rally Leads**`,
        leadText,
        '',
        `**Groups**`,
        groupText,
      ].join('\n')
    );
}

function buildDashboardRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('lead:register')
        .setLabel('Become Rally Lead')
        .setStyle(ButtonStyle.Primary),
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
  const leads = loadLeads();

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
          value: lead.userId,
          description: (lead.discordName || `User ${lead.userId}`).slice(0, 100),
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

async function refreshDashboardMessage() {
  try {
    const channel = await client.channels.fetch(SVS_CHANNEL_ID);

    if (!channel || !channel.isTextBased()) {
      console.error('SVS channel is not text-based or not found.');
      return;
    }

    const payload = {
      embeds: [buildDashboardEmbed()],
      components: buildDashboardRows(),
    };

    let existing = null;

    try {
      const recent = await channel.messages.fetch({ limit: 20 });
      existing = recent.find(
        (m) =>
          m.author.id === client.user.id &&
          m.embeds.length > 0 &&
          m.embeds[0].title === 'SvS Rally Lead Dashboard'
      );
    } catch (error) {
      console.warn('Could not read recent messages, sending a new dashboard.');
    }

    if (existing) {
      await existing.edit(payload);
    } else {
      await channel.send(payload);
    }
  } catch (error) {
    console.error('Failed to refresh dashboard message', error);
  }
}

function buildLaunchPlanFromOffsetEmbed(
  groupName,
  offsetSeconds,
  longestLaunchTime,
  arrivalTime,
  leads
) {
  const lines = leads
    .map((lead) => {
      const launchTime = new Date(
        arrivalTime.getTime() - lead.rallySeconds * 1000
      );
      return `${lead.gameName} - ${formatUtcTime(launchTime)}`;
    })
    .join('\n');

  return new EmbedBuilder()
    .setTitle(`${groupName} Launch Plan`)
    .setDescription(
      [
        `Longest rally starts in **${offsetSeconds}s**`,
        `Longest launch: ${formatUtcTime(longestLaunchTime)}`,
        `Arrival: ${formatUtcTime(arrivalTime)}`,
        '',
        lines,
      ].join('\n')
    );
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  ensureJsonFile(leadsPath, []);
  ensureJsonFile(
    groupsPath,
    GROUP_NAMES.map((name) => ({ name, leadUserIds: [] }))
  );
  await refreshDashboardMessage();
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

      if (interaction.customId === 'dashboard:refresh') {
        await refreshDashboardMessage();
        await interaction.reply({
          content: 'Dashboard refreshed.',
          flags: MessageFlags.Ephemeral,
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
        const userId = interaction.values[0];
        const session = sessions.get(interaction.user.id);

        if (!session?.groupName) {
          await interaction.reply({
            content: 'Your session expired. Please start again.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const groups = loadGroups();

        for (const group of groups) {
          group.leadUserIds = group.leadUserIds.filter((id) => id !== userId);
        }

        const targetGroup = groups.find((g) => g.name === session.groupName);
        if (!targetGroup) {
          await interaction.update({
            content: 'Group not found.',
            components: [],
          });
          return;
        }

        if (!targetGroup.leadUserIds.includes(userId)) {
          targetGroup.leadUserIds.push(userId);
        }

        saveGroups(groups);
        sessions.delete(interaction.user.id);
        await refreshDashboardMessage();

        const leads = loadLeads();
        const lead = leads.find((l) => l.userId === userId);

        await interaction.update({
          content: `Assigned **${lead?.gameName || userId}** to **${targetGroup.name}**.`,
          components: [],
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
        const session = sessions.get(interaction.user.id);
        if (!session?.groupName) {
          await interaction.reply({
            content: 'Your session expired. Please start again.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const offsetSeconds = Number(interaction.values[0]);
        const groups = loadGroups();
        const leads = loadLeads();
        const group = groups.find((g) => g.name === session.groupName);

        if (!group) {
          await interaction.update({
            content: 'Group not found.',
            components: [],
          });
          return;
        }

        const groupLeads = group.leadUserIds
          .map((id) => leads.find((lead) => lead.userId === id))
          .filter(Boolean);

        if (groupLeads.length === 0) {
          await interaction.update({
            content: 'That group has no rally leads assigned.',
            components: [],
          });
          return;
        }

        const maxRallySeconds = Math.max(
          ...groupLeads.map((lead) => lead.rallySeconds)
        );

        const now = new Date();
        const rawLongestLaunchTime = new Date(
          now.getTime() + offsetSeconds * 1000
        );

        const longestLaunchTime = roundUpToNext15Seconds(rawLongestLaunchTime);

        const arrivalTime = new Date(
          longestLaunchTime.getTime() + maxRallySeconds * 1000
        );

        const channel = await client.channels.fetch(SVS_CHANNEL_ID);
        if (!channel || !channel.isTextBased()) {
          await interaction.update({
            content: 'SvS channel is not available.',
            components: [],
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

        await interaction.update({
          content: `Launch plan posted for **${group.name}**.`,
          components: [],
        });
        return;
      }
    }

    if (interaction.type === InteractionType.ModalSubmit) {
      if (interaction.customId === 'lead:register_modal') {
        const gameName = interaction.fields.getTextInputValue('game_name').trim();
        const rallySeconds = Number(
          interaction.fields.getTextInputValue('rally_seconds').trim()
        );

        if (!gameName) {
          await interaction.reply({
            content: 'Game Name is required.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (!Number.isFinite(rallySeconds) || rallySeconds <= 0) {
          await interaction.reply({
            content: 'Rally Time must be a valid number greater than 0.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        upsertLead({
          userId: interaction.user.id,
          discordName: interaction.member?.displayName || interaction.user.username,
          gameName,
          rallySeconds,
        });

        await refreshDashboardMessage();

        await interaction.reply({
          content: `Registered **${gameName}** with rally time **${rallySeconds}s**.`,
          flags: MessageFlags.Ephemeral,
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
