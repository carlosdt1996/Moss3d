interface Moss3DLogoProps {
  size?: number
  className?: string
  gradientId?: string
}

/** Moss3D mark — Star of David with blue gradient on black UI */
export function Moss3DLogo({ size = 26, className = '', gradientId = 'moss3d-logo' }: Moss3DLogoProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      className={`shrink-0 ${className}`}
      aria-hidden
    >
      <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#93C5FD" />
          <stop offset="50%" stopColor="#3B82F6" />
          <stop offset="100%" stopColor="#1D4ED8" />
        </linearGradient>
      </defs>
      <path fill={`url(#${gradientId})`} d="M12 2.5 L21.5 19 H2.5 Z" />
      <path fill={`url(#${gradientId})`} d="M12 21.5 L2.5 5 H21.5 Z" />
    </svg>
  )
}
