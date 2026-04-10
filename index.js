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
  StringSelectMenuBuilder,
  MessageFlags,
} = require('discord.js');

dotenv.config();

const TOKEN = process.env.DISCORD_TOKEN;
const SVS_CHANNEL_ID = process.env.SVS_CHANNEL_ID;
const RALLY_ROLE_NAME = process.env.RALLY_LEAD_ROLE_NAME || 'Rally Lead';
const DATA_DIR = process.env.DATA_DIR || __dirname;

if (!TOKEN || !SVS_CHANNEL_ID) {
  console.error('Missing required environment variables.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const sessions = new Map();
const ralliesPath = path.join(DATA_DIR, 'svs_rallies.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function ensureJsonFile(filePath) {
  ensureDataDir();
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '[]', 'utf8');
  }
}

function loadRallies() {
  ensureJsonFile(ralliesPath);
  try {
    return JSON.parse(fs.readFileSync(ralliesPath, 'utf8'));
  } catch (error) {
    console.error('Failed to read svs_rallies.json', error);
    return [];
  }
}

function saveRallies(rallies) {
  ensureJsonFile(ralliesPath);
  fs.writeFileSync(ralliesPath, JSON.stringify(rallies, null, 2), 'utf8');
}

function hasAccess(member) {
  return member?.roles?.cache?.some((r) => r.name === RALLY_ROLE_NAME);
}

function makeId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createTeams() {
  return {
    'ST8-1': [],
    'ST8-2': [],
    'ST2-1': [],
    'ST2-2': [],
  };
}

function activeRallies() {
  const now = Date.now();
  const rallies = loadRallies();
  let changed = false;

  for (const rally of rallies) {
    if (rally.active && rally.time <= now) {
      rally.active = false;
      changed = true;
    }
  }

  if (changed) {
    saveRallies(rallies);
  }

  return rallies.filter((r) => r.active);
}

function buildDashboardEmbed() {
  const rallies = activeRallies();

  const description =
    rallies.length === 0
      ? 'No active SvS rallies right now.'
      : rallies
          .slice(0, 10)
          .map((r, i) => {
            const teamCounts = Object.entries(r.teams)
              .map(([name, users]) => `${name}: ${users.length}`)
              .join(' | ');

            return [
              `**${i + 1}. ${r.type} - ${r.alliance}**`,
              `Starts: <t:${Math.floor(r.time / 1000)}:R>`,
              `Teams: ${teamCounts}`,
            ].join('\n');
          })
          .join('\n\n');

  return new EmbedBuilder()
    .setTitle('SvS Rally Dashboard')
    .setDescription(description);
}

function buildDashboardRows() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('dashboard:create_rally')
        .setLabel('Create SvS Rally')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('dashboard:view_rallies')
        .setLabel('View Active Rallies')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('dashboard:refresh')
        .setLabel('Refresh Dashboard')
        .setStyle(ButtonStyle.Secondary)
    ),
  ];
}

function buildAllianceSelect() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('rally:alliance')
      .setPlaceholder('Select alliance')
      .addOptions(
        { label: 'ZRH', value: 'ZRH' },
        { label: 'VIK', value: 'VIK' }
      )
  );
}

function buildTypeSelect() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('rally:type')
      .setPlaceholder('Select rally type')
      .addOptions(
        { label: 'Attack', value: 'ATTACK' },
        { label: 'Defense', value: 'DEFENSE' }
      )
  );
}

function buildStartSelect() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('rally:start')
      .setPlaceholder('Start in...')
      .addOptions(
        { label: '15 seconds', value: '15' },
        { label: '30 seconds', value: '30' },
        { label: '45 seconds', value: '45' },
        { label: '60 seconds', value: '60' }
      )
  );
}

function buildTeamButtons(id, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`team:${id}:ST8-1`)
      .setLabel('ST8-1')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`team:${id}:ST8-2`)
      .setLabel('ST8-2')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`team:${id}:ST2-1`)
      .setLabel('ST2-1')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`team:${id}:ST2-2`)
      .setLabel('ST2-2')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled)
  );
}

function buildRallyText(rally) {
  const teamText = Object.entries(rally.teams)
    .map(([name, users]) => {
      const mentions = users.length
        ? users.map((id) => `<@${id}>`).join(', ')
        : '';
      return `${name} (${users.length}): ${mentions}`;
    })
    .join('\n');

  return [
    `🔥 **SvS Rally - ${rally.type}**`,
    `Alliance: **${rally.alliance}**`,
    `Starts: <t:${Math.floor(rally.time / 1000)}:R>`,
    '',
    `**Teams:**`,
    teamText,
  ].join('\n');
}

async function refreshDashboardMessage() {
  try {
    const channel = await client.channels.fetch(SVS_CHANNEL_ID);

    if (!channel || !channel.isTextBased()) {
      console.error('SVS channel is not text-based or not found.');
      return;
    }

    console.log('SVS channel type:', channel.type, 'textBased:', channel.isTextBased());

    const recent = await channel.messages.fetch({ limit: 20 });
    const existing = recent.find(
      (m) =>
        m.author.id === client.user.id &&
        m.embeds.length > 0 &&
        m.embeds[0].title === 'SvS Rally Dashboard'
    );

    const payload = {
      embeds: [buildDashboardEmbed()],
      components: buildDashboardRows(),
    };

    if (existing) {
      await existing.edit(payload);
    } else {
      await channel.send(payload);
    }
  } catch (error) {
    console.error('Failed to refresh dashboard message', error);
  }
}

async function refreshRallyMessage(rally) {
  try {
    if (!rally.messageId) return;

    const channel = await client.channels.fetch(SVS_CHANNEL_ID);
    if (!channel || !channel.isTextBased()) {
      return;
    }

    const message = await channel.messages.fetch(rally.messageId);

    await message.edit({
      content: buildRallyText(rally),
      components: [buildTeamButtons(rally.id, !rally.active)],
    });
  } catch (error) {
    console.error('Failed to refresh rally message', error);
  }
}

async function closeExpiredRallies() {
  const rallies = loadRallies();
  const now = Date.now();
  let changed = false;

  for (const rally of rallies) {
    if (rally.active && rally.time <= now) {
      rally.active = false;
      changed = true;
      await refreshRallyMessage(rally);
    }
  }

  if (changed) {
    saveRallies(rallies);
    await refreshDashboardMessage();
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  ensureJsonFile(ralliesPath);
  await refreshDashboardMessage();

  setInterval(() => {
    closeExpiredRallies().catch((error) =>
      console.error('Failed to close expired rallies', error)
    );
  }, 5000);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton()) {
      if (interaction.customId.startsWith('dashboard:')) {
        if (!hasAccess(interaction.member)) {
          await interaction.reply({
            content: `You need the **${RALLY_ROLE_NAME}** role to use this.`,
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (interaction.customId === 'dashboard:create_rally') {
          sessions.set(interaction.user.id, {});
          await interaction.reply({
            content: 'Select alliance',
            components: [buildAllianceSelect()],
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        if (interaction.customId === 'dashboard:view_rallies') {
          const rallies = activeRallies();

          if (rallies.length === 0) {
            await interaction.reply({
              content: 'No active rallies.',
              flags: MessageFlags.Ephemeral,
            });
            return;
          }

          const text = rallies
            .map((r, i) => {
              const counts = Object.entries(r.teams)
                .map(([name, users]) => `${name}: ${users.length}`)
                .join(' | ');

              return [
                `**${i + 1}. ${r.type} - ${r.alliance}**`,
                `Starts: <t:${Math.floor(r.time / 1000)}:R>`,
                counts,
              ].join('\n');
            })
            .join('\n\n')
            .slice(0, 3500);

          await interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setTitle('Active Rallies')
                .setDescription(text),
            ],
            flags: MessageFlags.Ephemeral,
          });
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
      }

      if (interaction.customId.startsWith('team:')) {
        const [, rallyId, teamName] = interaction.customId.split(':');
        const rallies = loadRallies();
        const rally = rallies.find((r) => r.id === rallyId);

        if (!rally || !rally.active) {
          await interaction.reply({
            content: 'This rally is no longer active.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }

        const userId = interaction.user.id;

        for (const team of Object.keys(rally.teams)) {
          rally.teams[team] = rally.teams[team].filter((id) => id !== userId);
        }

        rally.teams[teamName].push(userId);

        saveRallies(rallies);
        await refreshRallyMessage(rally);
        await refreshDashboardMessage();

        await interaction.reply({
          content: `You joined **${teamName}**.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    if (interaction.isStringSelectMenu()) {
      const session = sessions.get(interaction.user.id);
      if (!session) return;

      if (!hasAccess(interaction.member)) {
        await interaction.reply({
          content: `You need the **${RALLY_ROLE_NAME}** role to use this.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (interaction.customId === 'rally:alliance') {
        session.alliance = interaction.values[0];
        sessions.set(interaction.user.id, session);

        await interaction.update({
          content: 'Select rally type',
          components: [buildTypeSelect()],
        });
        return;
      }

      if (interaction.customId === 'rally:type') {
        session.type = interaction.values[0];
        sessions.set(interaction.user.id, session);

        await interaction.update({
          content: 'Select start time',
          components: [buildStartSelect()],
        });
        return;
      }

      if (interaction.customId === 'rally:start') {
        const seconds = Number(interaction.values[0]);

        const rally = {
          id: makeId(),
          alliance: session.alliance,
          type: session.type,
          time: Date.now() + seconds * 1000,
          teams: createTeams(),
          active: true,
          createdBy: interaction.user.id,
          createdAt: new Date().toISOString(),
        };

        const rallies = loadRallies();
        rallies.push(rally);
        saveRallies(rallies);
        sessions.delete(interaction.user.id);

        const channel = await client.channels.fetch(SVS_CHANNEL_ID);
        if (!channel || !channel.isTextBased()) {
          await interaction.update({
            content: 'SvS channel is not available.',
            components: [],
          });
          return;
        }

        const sent = await channel.send({
          content: buildRallyText(rally),
          components: [buildTeamButtons(rally.id)],
        });

        rally.messageId = sent.id;

        const updatedRallies = loadRallies().map((r) =>
          r.id === rally.id ? { ...r, messageId: sent.id } : r
        );
        saveRallies(updatedRallies);

        await refreshDashboardMessage();

        await interaction.update({
          content: `🔥 Rally created (${seconds}s)`,
          components: [],
        });
        return;
      }
    }
  } catch (error) {
    console.error('Interaction error', error);

    if (interaction.deferred || interaction.replied) {
      await interaction
        .followUp({
          content: 'Something went wrong.',
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => null);
    } else {
      await interaction
        .reply({
          content: 'Something went wrong.',
          flags: MessageFlags.Ephemeral,
        })
        .catch(() => null);
    }
  }
});

client.login(TOKEN);
