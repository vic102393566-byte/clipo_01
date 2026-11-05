import type { Metadata } from "next";

import { LegalPage } from "@/components/legal/legal-page";

export const metadata: Metadata = { title: "Política de Privacidade" };

export default function PrivacyPage() {
  return (
    <LegalPage
      eyebrow="Privacidade e proteção de dados"
      title="Política de Privacidade do Clipo"
      updated="29 de outubro de 2026 · Versão 1.3"
      other={{ href: "/termos", label: "Termos de Serviço" }}
      intro={
        <p>
          A sua privacidade é fundamental para nós. Esta política descreve como o Clipo coleta, usa, guarda e protege seus
          dados pessoais e o acesso às redes sociais que você conecta.
        </p>
      }
      sections={[
        {
          title: "Dados que coletamos",
          body: (
            <>
              <p>
                <strong>Conta.</strong> Nome, e-mail e senha. A senha é guardada só como hash Argon2 (de mão única) e nunca em
                texto. Se você entra com Google ou Apple, guardamos apenas o identificador da conta nesse provedor.
              </p>
              <p>
                <strong>Redes sociais conectadas (OAuth 2.0).</strong> O Clipo nunca recebe a senha das suas redes. Guardamos:
              </p>
              <ul>
                <li>identificador do canal ou perfil (por exemplo, o open_id do TikTok);</li>
                <li>nome público e nome de usuário;</li>
                <li>endereço da foto de perfil e número aproximado de seguidores, para exibir no painel;</li>
                <li>tokens de acesso e de renovação, guardados criptografados no servidor.</li>
              </ul>
              <p>
                <strong>Conteúdo.</strong> Vídeos que você envia, prévias, miniaturas, cortes, transcrições, legendas e os textos
                das publicações.
              </p>
              <p>
                <strong>Pagamento.</strong> As cobranças são feitas pelo Asaas. O Clipo não recebe número de cartão; guarda só os
                quatro últimos dígitos do CPF ou CNPJ e o histórico das faturas.
              </p>
              <p>
                <strong>Uso e segurança.</strong> Registros técnicos (horário, ação, aparelho e endereço IP) para segurança,
                suporte e prevenção de abuso.
              </p>
            </>
          ),
        },
        {
          title: "Tratamento de dados do TikTok (API oficial v2)",
          body: (
            <>
              <p>
                O Clipo segue os TikTok Developer Terms of Service e a TikTok API Policy, e usa a Content Posting API para
                publicar os vídeos que você agenda.
              </p>
              <ul>
                <li>
                  <strong>user.info.basic e user.info.profile:</strong> identificar a conta conectada e mostrar nome, foto e
                  seguidores no painel;
                </li>
                <li>
                  <strong>video.upload e video.publish:</strong> enviar e publicar o vídeo agendado na hora marcada ou quando você
                  pedir para publicar agora.
                </li>
              </ul>
              <p>
                O Clipo <strong>não</strong> compartilha, vende ou transfere dados obtidos pela API do TikTok para publicidade
                direcionada, corretores de dados ou sistemas de rastreamento.
              </p>
            </>
          ),
        },
        {
          title: "Para que usamos os dados",
          body: (
            <ul>
              <li>autenticar seu acesso com segurança;</li>
              <li>processar, cortar, transcrever e legendar seus vídeos;</li>
              <li>manter a agenda e publicar na data e hora escolhidas;</li>
              <li>calcular o uso do plano (espaço, vídeos e créditos de IA) e cobrar a assinatura;</li>
              <li>avisar sobre publicações, falhas, cobranças e o espaço do plano;</li>
              <li>garantir a segurança, prevenir abuso e cumprir obrigações legais.</li>
            </ul>
          ),
        },
        {
          title: "Inteligência artificial",
          body: (
            <>
              <p>
                Quando você pede uma transcrição, sugestões de corte ou o texto de uma publicação, o áudio ou a transcrição do
                vídeo é processado pelo Clipo. A transcrição pode rodar no próprio servidor do Clipo ou num provedor de IA
                contratado; textos e sugestões podem ser gerados por provedores como Google (Gemini), Anthropic (Claude) ou
                OpenAI.
              </p>
              <p>Usamos esses provedores só para entregar o resultado pedido, nunca para treinar modelos com o seu conteúdo.</p>
            </>
          ),
        },
        {
          title: "Armazenamento e segurança",
          body: (
            <ul>
              <li>Toda a comunicação é criptografada (HTTPS/TLS).</li>
              <li>Tokens das redes sociais ficam criptografados e nunca são enviados ao navegador.</li>
              <li>Arquivos ficam em armazenamento de objetos privado, acessível só por links temporários assinados.</li>
              <li>Ações sensíveis (troca de senha, papel, plano, acesso de suporte) ficam registradas em auditoria.</li>
            </ul>
          ),
        },
        {
          title: "Seus direitos (LGPD)",
          body: (
            <ul>
              <li>
                <strong>Baixar seus dados:</strong> em Configurações, Privacidade, você baixa um arquivo com conta, vídeos,
                cortes, publicações, faturas e histórico.
              </li>
              <li>
                <strong>Desconectar redes:</strong> em Redes sociais, “Desconectar” apaga os tokens da conta na hora e revoga o
                acesso quando a rede permite.
              </li>
              <li>
                <strong>Excluir a conta:</strong> em Configurações. Tudo é apagado de vez depois de 7 dias; até lá, entrar de novo
                cancela a exclusão.
              </li>
              <li>
                <strong>Revogar pelo provedor:</strong> você também pode remover o acesso do Clipo nas configurações de segurança
                do TikTok, do Google ou da Meta.
              </li>
            </ul>
          ),
        },
        {
          title: "Compartilhamento com terceiros",
          body: (
            <>
              <p>Não vendemos seus dados. Compartilhamos apenas:</p>
              <ul>
                <li>com TikTok, YouTube (Google) e Instagram (Meta), só para publicar o que você agendou e aprovou;</li>
                <li>com o Asaas, para cobrar a assinatura;</li>
                <li>com provedores de IA, nos casos descritos acima;</li>
                <li>com provedores de infraestrutura (servidores, armazenamento e e-mail), sob contrato de confidencialidade;</li>
                <li>quando exigido por ordem judicial ou lei.</li>
              </ul>
            </>
          ),
        },
        {
          title: "Contato do encarregado (DPO)",
          body: (
            <ul>
              <li>Aplicação: Clipo (gestão, corte e publicação de vídeos)</li>
              <li>Controlador: [Razão social: Clipo Tecnologia]</li>
              <li>E-mail de privacidade: [privacidade@clipo.app]</li>
            </ul>
          ),
        },
      ]}
    />
  );
}
