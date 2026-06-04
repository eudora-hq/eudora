export const CRON_PRESETS = [
  { label: 'Every hour',            value: '0 * * * *'    },
  { label: 'Every day at 9am',      value: '0 9 * * *'    },
  { label: 'Every day at midnight', value: '0 0 * * *'    },
  { label: 'Every Monday at 9am',   value: '0 9 * * 1'    },
  { label: 'Every Friday at 5pm',   value: '0 17 * * 5'   },
  { label: 'Every 1st of month',    value: '0 9 1 * *'    },
  { label: 'Every 15 minutes',      value: '*/15 * * * *' },
  { label: 'Custom',                value: 'custom'       },
]