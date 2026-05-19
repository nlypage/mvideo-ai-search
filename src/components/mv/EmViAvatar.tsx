type EmViAvatarProps = {
  className?: string;
  imageClassName?: string;
};

export function EmViAvatar({ className = "h-12 w-12", imageClassName = "" }: EmViAvatarProps) {
  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-[var(--mv-red)] via-[#ff4d7d] to-[#16c6d9] p-[2px] shadow-sm ${className}`}
      aria-label="Эм.Ви"
    >
      <img
        src="/emvi/avatar-small.png"
        alt="Эм.Ви - виртуальный амбассадор М.Видео"
        className={`h-full w-full rounded-full bg-white object-cover ${imageClassName}`}
        loading="lazy"
      />
      <span className="absolute bottom-0.5 right-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-emerald-500" />
    </span>
  );
}
