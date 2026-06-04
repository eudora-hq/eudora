module.exports = {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        'bg': '#050505',
        'surface': '#0a0a0a',
        'surface-high': '#141414',
        'primary': '#10b981',
        'on-primary': '#050505',
        'text-muted': '#A3A3A3',
        'border-dim': '#1a1a1a',
        'warning': '#f59e0b',
        'danger': '#ef4444',
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', 'monospace'],
        sans: ['Inter', 'sans-serif'],
      },
      borderRadius: {
        DEFAULT: '0px',
        none: '0px',
        sm: '0px',
        md: '0px',
        lg: '0px',
        xl: '0px',
      },
    },
  },
  plugins: [],
}
