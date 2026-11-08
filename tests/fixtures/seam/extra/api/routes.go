package main

func register(r chi.Router, router chi.Router, mux chi.Router) {
	r.Get("/users/{id}", handler)
	router.Post("/users", handler)
	mux.Put("/widgets/{id}", handler)
	mux.Patch("/widgets/{id}", handler)
	mux.Delete("/widgets/{id}", handler)
	r.get("/ignored-lowercase", handler)
}
