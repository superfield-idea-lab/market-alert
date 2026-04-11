/**
 * @file Button.tsx
 *
 * Design system Button primitive.
 *
 * Renders a semantically correct <button> element styled via CSS custom
 * properties from tokens.css.  Supports three variants (primary, secondary,
 * ghost), three sizes (sm, md, lg), and a disabled state.
 *
 * The component emits no Tailwind classes — it relies entirely on the design
 * token variables so the catalog and application environments use identical
 * styles without a shared CSS framework.
 *
 * Canonical docs: calypso-blueprint/rules/blueprints/ux.yaml
 */

import React from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children: React.ReactNode;
}

const sizeStyles: Record<ButtonSize, React.CSSProperties> = {
  sm: {
    fontSize: 'var(--font-size-sm)',
    padding: 'var(--spacing-1) var(--spacing-3)',
    borderRadius: 'var(--radius-md)',
  },
  md: {
    fontSize: 'var(--font-size-sm)',
    padding: 'var(--spacing-2) var(--spacing-4)',
    borderRadius: 'var(--radius-md)',
  },
  lg: {
    fontSize: 'var(--font-size-md)',
    padding: 'var(--spacing-3) var(--spacing-6)',
    borderRadius: 'var(--radius-lg)',
  },
};

const variantStyles: Record<ButtonVariant, React.CSSProperties> = {
  primary: {
    backgroundColor: 'var(--color-interactive-default)',
    color: 'var(--color-text-inverse)',
    border: '1px solid transparent',
  },
  secondary: {
    backgroundColor: 'var(--color-surface-base)',
    color: 'var(--color-text-primary)',
    border: '1px solid var(--color-border-strong)',
  },
  ghost: {
    backgroundColor: 'transparent',
    color: 'var(--color-text-primary)',
    border: '1px solid transparent',
  },
};

const variantHoverStyles: Record<ButtonVariant, React.CSSProperties> = {
  primary: {
    backgroundColor: 'var(--color-interactive-hover)',
  },
  secondary: {
    backgroundColor: 'var(--color-surface-muted)',
  },
  ghost: {
    backgroundColor: 'var(--color-surface-muted)',
  },
};

/**
 * Button primitive component.
 *
 * States supported:
 * - default
 * - hover   (via CSS :hover — reflected in inline style via React state)
 * - focus   (browser outline using --color-focus-ring)
 * - disabled
 */
export function Button({
  variant = 'primary',
  size = 'md',
  children,
  disabled,
  style,
  onMouseEnter,
  onMouseLeave,
  ...rest
}: ButtonProps) {
  const [hovered, setHovered] = React.useState(false);

  const baseStyle: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'var(--font-family-sans)',
    fontWeight: 'var(--font-weight-medium)' as React.CSSProperties['fontWeight'],
    lineHeight: 'var(--line-height-tight)',
    letterSpacing: 'var(--letter-spacing-wide)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: `background-color var(--transition-base), color var(--transition-base), border-color var(--transition-base), box-shadow var(--transition-base)`,
    outline: 'none',
    userSelect: 'none',
    whiteSpace: 'nowrap',
    ...sizeStyles[size],
    ...variantStyles[variant],
    ...(hovered && !disabled ? variantHoverStyles[variant] : {}),
    ...(disabled
      ? {
          opacity: 0.4,
          pointerEvents: 'none',
        }
      : {}),
    ...style,
  };

  const focusStyle = `
    button.ds-button:focus-visible {
      outline: 2px solid var(--color-focus-ring);
      outline-offset: 2px;
    }
  `;

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: focusStyle }} />
      <button
        className="ds-button"
        disabled={disabled}
        style={baseStyle}
        onMouseEnter={(e) => {
          setHovered(true);
          onMouseEnter?.(e);
        }}
        onMouseLeave={(e) => {
          setHovered(false);
          onMouseLeave?.(e);
        }}
        {...rest}
      >
        {children}
      </button>
    </>
  );
}
