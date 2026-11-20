// Claude starts a separate process. Keep the desktop process as the sole owner
// of DuckDB, result files, notebook edits, and preview events.
use anyhow::{ensure, Context, Result};
use rmcp::{
    model::{
        CallToolRequestParams, CallToolResponse, ListToolsResult, PaginatedRequestParams,
        ServerConfig,
    },
    service::RequestContext,
    transport::{
        stdio, streamable_http_client::StreamableHttpClientTransportConfig,
        StreamableHttpClientTransport,
    },
    ErrorData, Peer, RoleClient, RoleServer, ServerHandler, ServiceError, ServiceExt,
};
use std::time::Duration;

pub(super) const TOKEN_ENV: &str = "LEDGERVIEW_MCP_TOKEN";
pub(super) const PORT_ENV: &str = "LEDGERVIEW_MCP_PORT";

struct DesktopTools {
    peer: Peer<RoleClient>,
    info: ServerConfig,
}

fn mcp_error(error: ServiceError) -> ErrorData {
    match error {
        ServiceError::McpError(e) => e,
        e => ErrorData::internal_error(e.to_string(), None),
    }
}

impl ServerHandler for DesktopTools {
    fn get_info(&self) -> ServerConfig {
        self.info.clone()
    }

    async fn list_tools(
        &self,
        params: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        self.peer.list_tools(params).await.map_err(mcp_error)
    }

    async fn call_tool(
        &self,
        params: CallToolRequestParams,
        _: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        self.peer
            .call_tool(params)
            .await
            .map(Into::into)
            .map_err(mcp_error)
    }
}

pub(crate) fn run() -> Result<()> {
    let token = std::env::var(TOKEN_ENV).context(
        "Set LEDGERVIEW_MCP_TOKEN using the Claude Desktop config copied from LedgerView",
    )?;
    ensure!(!token.is_empty(), "Missing LedgerView MCP token");
    let port: u16 = std::env::var(PORT_ENV)
        .unwrap_or_else(|_| super::settings::DEFAULT_PORT.to_string())
        .parse()
        .context("Invalid LEDGERVIEW_MCP_PORT")?;
    ensure!(port > 0, "Invalid LEDGERVIEW_MCP_PORT");
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?
        .block_on(async { serve(port, token, stdio()).await })
}

pub(super) async fn serve<R, W>(port: u16, token: String, io: (R, W)) -> Result<()>
where
    R: tokio::io::AsyncRead + Send + Unpin + 'static,
    W: tokio::io::AsyncWrite + Send + Unpin + 'static,
{
    let url = format!("http://127.0.0.1:{port}/mcp");
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(3))
        .build()?;
    let config = StreamableHttpClientTransportConfig::with_uri(url.clone()).auth_header(token);
    let transport = StreamableHttpClientTransport::with_client(client, config);
    let mut desktop = ().serve(transport).await.with_context(|| {
        format!(
            "Could not connect to {url}. Open LedgerView, enable MCP, and check the port and token"
        )
    })?;
    let info = desktop
        .peer_info()
        .context("Desktop did not return server information")?;
    let mut local_info = ServerConfig::new(info.capabilities.clone());
    if let Some(identity) = &info.server_info {
        local_info.server_info = identity.clone();
    }
    local_info.instructions = info.instructions.clone();
    let proxy = DesktopTools {
        peer: desktop.peer().clone(),
        info: local_info,
    };
    proxy.serve(io).await?.waiting().await?;
    desktop.close().await?;
    Ok(())
}
