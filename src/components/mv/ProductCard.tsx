import { Star, ShoppingCart, ExternalLink, Package, Store } from "lucide-react";
import type { Product } from "@/lib/mv-llm";

export function ProductCard({
  product,
  onAdd,
  showStock = false,
  showMargin = false,
  compact = false,
}: {
  product: Product;
  onAdd?: (p: Product) => void;
  showStock?: boolean;
  showMargin?: boolean;
  compact?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-3 flex gap-3">
      <img
        src={product.image}
        alt={product.title}
        className={`${compact ? "h-16 w-16" : "h-24 w-24"} flex-shrink-0 rounded-md object-cover bg-muted`}
        loading="lazy"
      />
      <div className="flex-1 min-w-0 flex flex-col">
        <a
          href={product.url}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-medium leading-snug line-clamp-2 hover:text-[var(--mv-red)]"
        >
          {product.title}
        </a>
        <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-0.5">
            <Star className="h-3 w-3 fill-amber-400 stroke-amber-400" />
            {product.rating}
          </span>
          <span>· {product.reviews} отзывов</span>
          <a
            href={product.url}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-0.5 hover:text-[var(--mv-red)]"
          >
            mvideo.ru <ExternalLink className="h-3 w-3" />
          </a>
        </div>

        {showStock && (
          <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
            <span
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 ${product.stock.warehouse > 0 ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}
            >
              <Package className="h-3 w-3" /> Склад: {product.stock.warehouse}
            </span>
            <span
              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 ${product.stock.store > 0 ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}
            >
              <Store className="h-3 w-3" /> {product.stock.storeName}: {product.stock.store}
            </span>
            {showMargin && product.margin != null && (
              <span className="inline-flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-amber-700">
                Маржа {product.margin}%
              </span>
            )}
          </div>
        )}

        <div className="mt-2 flex items-end justify-between gap-2">
          <div>
            <div className="text-lg font-bold leading-none">
              {product.price.toLocaleString("ru")} ₽
            </div>
            {product.oldPrice && (
              <div className="text-xs text-muted-foreground line-through">
                {product.oldPrice.toLocaleString("ru")} ₽
              </div>
            )}
          </div>
          {onAdd && (
            <button
              onClick={() => onAdd(product)}
              className="inline-flex items-center gap-1 rounded-md bg-[var(--mv-red)] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[var(--mv-red-dark)] transition-colors"
            >
              <ShoppingCart className="h-3.5 w-3.5" /> В корзину
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
