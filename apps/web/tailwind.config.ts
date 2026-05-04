import { join } from 'path';
import type { Config } from 'tailwindcss';
import {
  colorTokens,
  fontSizeTokens,
  spacingTokens,
  borderRadiusTokens,
  fontWeightTokens,
} from '../../packages/ui/design-system/tokens';

const dir = import.meta.dirname ?? __dirname;

const config: Config = {
  content: [join(dir, 'index.html'), join(dir, 'src/**/*.{js,ts,jsx,tsx}')],
  theme: {
    extend: {
      colors: colorTokens,
      fontSize: Object.fromEntries(
        Object.entries(fontSizeTokens).map(
          ([k, v]) => [k, [v, { lineHeight: '1.5' }]] as [string, [string, { lineHeight: string }]],
        ),
      ),
      spacing: spacingTokens,
      borderRadius: borderRadiusTokens,
      fontWeight: fontWeightTokens,
    },
  },
  plugins: [],
};

export default config;
