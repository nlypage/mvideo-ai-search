const MVIDEO_LOGO_URL =
  "https://cms.mvideo.ru/magnoliaPublic/dam//jcr:b03f6e0e-f064-4f7b-bb9e-fec5591fe0de";

export function MVideoLogo({ className = "h-10" }: { className?: string }) {
  return (
    <a href="/" aria-label="М.Видео" className={`inline-flex items-center ${className}`}>
      <img
        src={MVIDEO_LOGO_URL}
        alt="М.Видео"
        className="h-full w-auto object-contain"
        draggable={false}
      />
    </a>
  );
}
