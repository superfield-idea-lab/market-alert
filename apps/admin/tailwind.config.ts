import { join } from 'path';
import {
  colorTokens,
  fontSizeTokens,
  spacingTokens,
  borderRadiusTokens,
  fontWeightTokens,
} from '../../packages/ui/design-system/tokens';

const dir = import.meta.dirname ?? __dirname;

/** @type {import('tailwindcss').Config} */
export default {
  content: [join(dir, 'index.html'), join(dir, 'src/**/*.{js,ts,jsx,tsx}')],
  theme: {
    extend: {
      colors: colorTokens,
      fontSize: Object.fromEntries(
        Object.entries(fontSizeTokens).map(([k, v]) => [k, [v, { lineHeight: '1.5' }]]),
      ),
      spacing: spacingTokens,
      borderRadius: borderRadiusTokens,
      fontWeight: fontWeightTokens,
    },
  },
  plugins: [],
};
