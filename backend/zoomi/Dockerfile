FROM rust:1.87 AS build
WORKDIR /usr/src/zoomi

COPY . .

RUN make

FROM debian:buster-slim
WORKDIR /usr/local/bin

COPY --from=build /usr/src/zoomi/target/debug/zoomi .

EXPOSE 8080

CMD ["./zoomi"]