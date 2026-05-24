# Gagamit tayo ng official at magaan na Deno image base sa Alpine Linux
FROM denoland/deno:alpine-2.0.6

# I-set ang working directory sa loob ng container
WORKDIR /app

# I-copy ang iyong main.ts file papunta sa loob ng container
COPY main.ts .

# I-compile at i-cache ang main.ts para mabilis mag-boot ang app sa Railway
RUN deno cache main.ts

# Sasabihin natin sa Railway na gumagamit tayo ng port (default ay 8080 kung walang ibigay)
EXPOSE 8080

# Patakbuhin ang proxy server gamit ang mga kailangang permissions
# --allow-net para makapag-fetch ng IPTV streams
# --allow-env para mabasa ang PORT variable ng Railway
CMD ["run", "--allow-net", "--allow-env", "main.ts"]
