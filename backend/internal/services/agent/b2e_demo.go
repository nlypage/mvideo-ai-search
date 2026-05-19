package agent

import (
	"hash/fnv"
	"strings"

	catalog "github.com/nlypage/mvideo-ai-search/backend/internal/domain/catalog"
)

const b2eDemoStoreName = "ТЦ Авиапарк"

func enrichB2EProducts(products []catalog.Product) []catalog.Product {
	out := make([]catalog.Product, len(products))
	for index, product := range products {
		out[index] = enrichB2EProduct(product)
	}
	return out
}

func enrichB2EProduct(product catalog.Product) catalog.Product {
	key := firstNonEmpty(product.ID, product.Title, product.Category)
	margin := b2eDemoMargin(product, key)
	product.Margin = &margin
	product.Stock.Warehouse = 2 + stableB2EHash(key+":warehouse")%39
	product.Stock.Store = stableB2EHash(key+":store") % 6
	product.Stock.StoreName = b2eDemoStoreName
	return product
}

func b2eDemoMargin(product catalog.Product, key string) int {
	margin := 3 + stableB2EHash(key+":margin")%10
	text := strings.ToLower(product.Title + " " + product.Category)
	price := product.Price
	if strings.Contains(text, "аксесс") || strings.Contains(text, "кабель") || strings.Contains(text, "чехол") || strings.Contains(text, "наушник") || strings.Contains(text, "мыш") || strings.Contains(text, "клавиат") {
		margin += 2
	}
	if price >= 120000 || strings.Contains(text, "oled") || strings.Contains(text, "qled") || strings.Contains(text, "iphone") || strings.Contains(text, "galaxy s") {
		margin -= 2
	}
	if margin < 3 {
		return 3
	}
	if margin > 12 {
		return 12
	}
	return margin
}

func stableB2EHash(value string) int {
	h := fnv.New32a()
	_, _ = h.Write([]byte(value))
	return int(h.Sum32())
}
