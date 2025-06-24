FROM rust:1.87 AS build
WORKDIR /usr/src/zoomi

COPY . .

RUN make

FROM debian:bookworm-slim
WORKDIR /usr/local/bin

COPY --from=build /usr/src/zoomi/target/release/zoomi .

EXPOSE 8000

CMD ["./zoomi"]