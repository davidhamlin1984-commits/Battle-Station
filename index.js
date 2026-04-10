const dotenv = require('dotenv');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  Events,
  GatewayIntentBits,
  StringSelectMenuBuilder,
  MessageFlags,
} = require('discord.js');

dotenv.config();

const TOKEN = process.env.DISCORD_TOKEN;
const SVS_CHANNEL_ID = process.env.SVS_CHANNEL_ID;
const RALLY_ROLE_NAME = process.env.RALLY_LEAD_ROLE_NAME || 'Rally Lead';

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const sessions = new Map();
const rallies = new Map();

function hasAccess(member) {
  return member.roles.cache.some(r => r.name === RALLY_ROLE_NAME);
}

function makeId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createTeams() {
  return { 'ST8-1': [], 'ST8-2': [], 'ST2-1': [], 'ST2-2': [] };
}

function buildRallyText(rally) {
  const teamText = Object.entries(rally.teams)
    .map(([name, users]) => `${name} (${users.length}): ${users.map(id => `<@${id}>`).join(', ')}`)
    .join('\n');

  return `🔥 SvS Rally – ${rally.type}\nAlliance: ${rally.alliance}\nStarts: <t:${Math.floor(rally.time/1000)}:R>\n\nTeams:\n${teamText}`;
}

function allianceSelect() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('alliance').addOptions(
      { label: 'ZRH', value: 'ZRH' },
      { label: 'VIK', value: 'VIK' }
    )
  );
}

function typeSelect() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('type').addOptions(
      { label: 'Attack', value: 'ATTACK' },
      { label: 'Defense', value: 'DEFENSE' }
    )
  );
}

function startSelect() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('start').addOptions(
      { label: '15 seconds', value: '15' },
      { label: '30 seconds', value: '30' },
      { label: '45 seconds', value: '45' },
      { label: '60 seconds', value: '60' }
    )
  );
}

function teamButtons(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`team:${id}:ST8-1`).setLabel('ST8-1').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`team:${id}:ST8-2`).setLabel('ST8-2').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`team:${id}:ST2-1`).setLabel('ST2-1').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`team:${id}:ST2-2`).setLabel('ST2-2').setStyle(ButtonStyle.Secondary)
  );
}

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isButton()) {
    if (!hasAccess(interaction.member)) return;

    if (interaction.customId === 'create_rally') {
      sessions.set(interaction.user.id, {});
      return interaction.reply({ content: 'Select alliance', components: [allianceSelect()], flags: MessageFlags.Ephemeral });
    }

    if (interaction.customId.startsWith('team:')) {
      const [_, id, team] = interaction.customId.split(':');
      const rally = rallies.get(id);
      if (!rally) return;

      const userId = interaction.user.id;
      for (const t in rally.teams) {
        rally.teams[t] = rally.teams[t].filter(u => u !== userId);
      }
      rally.teams[team].push(userId);

      return interaction.update({ content: buildRallyText(rally), components: [teamButtons(id)] });
    }
  }

  if (interaction.isStringSelectMenu()) {
    const session = sessions.get(interaction.user.id);
    if (!session) return;

    if (interaction.customId === 'alliance') {
      session.alliance = interaction.values[0];
      return interaction.update({ content: 'Select type', components: [typeSelect()] });
    }

    if (interaction.customId === 'type') {
      session.type = interaction.values[0];
      return interaction.update({ content: 'Select start', components: [startSelect()] });
    }

    if (interaction.customId === 'start') {
      const seconds = Number(interaction.values[0]);
      const rally = {
        id: makeId(),
        alliance: session.alliance,
        type: session.type,
        time: Date.now() + seconds * 1000,
        teams: createTeams()
      };

      rallies.set(rally.id, rally);
      sessions.delete(interaction.user.id);

      const channel = await client.channels.fetch(SVS_CHANNEL_ID);
      await channel.send({ content: buildRallyText(rally), components: [teamButtons(rally.id)] });

      return interaction.update({ content: 'Rally created', components: [] });
    }
  }
});

client.once(Events.ClientReady, () => console.log('Bot Ready'));
client.login(TOKEN);
