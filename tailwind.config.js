/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: { DEFAULT: '#2b2b2b', soft: '#5c5c5c', faint: '#8a8a8a' },
        paper: { DEFAULT: '#ffffff', soft: '#fafafa', deep: '#f5f5f5' },
        accent: { DEFAULT: '#3b82f6', soft: '#5b8def' },
        ok: '#2faa5d',
        err: '#d9534f',
        warn: '#e0a800',
        line: '#e6e6e6',
        sm: {
          bg: { DEFAULT: 'var(--sm-bg)', soft: 'var(--sm-bg-soft)', deep: 'var(--sm-bg-deep)' },
          ink: { DEFAULT: 'var(--sm-ink)', soft: 'var(--sm-ink-soft)', faint: 'var(--sm-ink-faint)' },
          line: 'var(--sm-line)',
          accent: { DEFAULT: 'var(--sm-accent)', soft: 'var(--sm-accent-soft)' },
          ok: 'var(--sm-ok)',
          err: 'var(--sm-err)',
          run: 'var(--sm-run)',
          edge: 'var(--sm-edge)',
          canvas: { DEFAULT: 'var(--sm-canvas)', grid: 'var(--sm-canvas-grid)' },
          panel: 'var(--sm-panel)',
        }
      },
      zIndex: {
        dropdown: '100',
        modal: '200',
        overlay: '300',
        drag: '10000',
        fatal: '99999',
      },
      fontFamily: {
        app: [
          '-apple-system',
          "'Segoe UI'",
          "'PingFang SC'",
          "'Microsoft YaHei'",
          'sans-serif',
        ],
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
